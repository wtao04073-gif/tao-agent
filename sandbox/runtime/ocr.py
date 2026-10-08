"""仅供隔离沙箱 worker 调用的有界 OCR；不接受工作区外路径，不访问网络。"""
from __future__ import annotations

import io
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
import warnings as python_warnings

ROOT = Path("/workspace")
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_PDF_PAGES = 10
MAX_SOURCE_PIXELS = 20_000_000
MAX_PAGE_PIXELS = 8_000_000
MAX_DIMENSION = 4096
MAX_TEXT_CHARS = 60_000
PAGE_TIMEOUT_SECONDS = 15.0
TOTAL_TIMEOUT_SECONDS = 90.0


class OCRError(RuntimeError):
    """调用方应作为失败返回，不能转成空文本成功。"""


def _read_source(raw: str) -> tuple[bytes, str]:
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise OCRError("OCR文件路径无效")
    root = ROOT.resolve(strict=True)
    candidate = Path(raw) if Path(raw).is_absolute() else ROOT / raw
    try:
        # 在解析前拒绝每一级符号链接，避免跟随用户上传文件的链接。
        for part in [candidate, *candidate.parents]:
            if part == ROOT.parent:
                break
            if part.is_symlink():
                raise OCRError("OCR不允许符号链接")
        path = candidate.resolve(strict=True)
        if not path.is_relative_to(root) or path == root:
            raise OCRError("OCR只允许访问沙箱工作目录内的文件")
        if path.suffix.lower() not in {".pdf", ".png", ".jpg", ".jpeg", ".webp"}:
            raise OCRError("OCR仅支持PDF、PNG、JPEG和WebP")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                raise OCRError("OCR输入须为普通文件，不接受硬链接")
            if info.st_size == 0 or info.st_size > MAX_FILE_BYTES:
                raise OCRError("OCR输入须为非空文件，最大20 MiB")
            data = source.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES or len(data) != info.st_size:
                raise OCRError("OCR输入大小超限或读取过程中发生变化")
        return data, path.suffix.lower()
    except OCRError:
        raise
    except (OSError, ValueError):
        raise OCRError("OCR文件不存在、不可读取或路径无效") from None


def _dependencies(language: str, needs_pdf: bool):
    if not isinstance(language, str) or len(language) > 80 or not re.fullmatch(r"[a-z][a-z0-9_]*(?:\+[a-z][a-z0-9_]*)*", language):
        raise OCRError("OCR语言参数无效，例如chi_sim+eng")
    try:
        from PIL import Image, ImageOps
        import pytesseract
    except ImportError:
        raise OCRError("沙箱缺少OCR组件Pillow或pytesseract，请安装固定版本依赖") from None
    pdfium = None
    if needs_pdf:
        try:
            import pypdfium2 as pdfium
        except ImportError:
            raise OCRError("沙箱缺少PDF OCR组件pypdfium2，请安装固定版本依赖") from None
    binary = shutil.which("tesseract")
    if not binary:
        raise OCRError("沙箱缺少Tesseract识别程序，请安装tesseract-ocr")
    # Tesseract/OpenMP只能单线程运行；限制直接作用于本次识别子进程。
    os.environ["OMP_THREAD_LIMIT"] = "1"
    os.environ["OMP_NUM_THREADS"] = "1"
    try:
        result = subprocess.run([binary, "--list-langs"], capture_output=True, text=True, timeout=5, check=True)
    except (OSError, subprocess.SubprocessError):
        raise OCRError("无法查询Tesseract语言数据，程序不可用或查询超时") from None
    available = set((result.stdout + "\n" + result.stderr).splitlines())
    missing = set(language.split("+")) - available
    if missing:
        raise OCRError("沙箱缺少OCR语言数据：" + "、".join(sorted(missing)))
    pytesseract.pytesseract.tesseract_cmd = binary
    return Image, ImageOps, pytesseract, pdfium


def _target_size(width: float, height: float) -> tuple[int, int]:
    if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
        raise OCRError("页面尺寸无效")
    scale = min(1.0, MAX_DIMENSION / max(width, height), math.sqrt(MAX_PAGE_PIXELS / (width * height)))
    return max(1, math.floor(width * scale)), max(1, math.floor(height * scale))


def _image_from_bytes(data: bytes, Image, ImageOps):
    try:
        with python_warnings.catch_warnings():
            python_warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as source:
                if source.format not in {"PNG", "JPEG", "WEBP"}:
                    raise OCRError("文件内容不是PNG、JPEG或WebP图片")
                if getattr(source, "n_frames", 1) != 1:
                    raise OCRError("暂不支持多帧或动画图片，请提供单帧扫描件")
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > MAX_SOURCE_PIXELS or max(width, height) > 20000:
                    raise OCRError("源图片尺寸超过安全上限（2000万像素）")
                # 在图像解码前完成尺寸校验；随后最多处理2000万源像素。
                source.load()
                oriented = ImageOps.exif_transpose(source)
                try:
                    if "A" in oriented.getbands() or "transparency" in oriented.info:
                        rgba = oriented.convert("RGBA")
                        mask = rgba.getchannel("A")
                        try:
                            rgb = Image.new("RGB", rgba.size, "white")
                            rgb.paste(rgba, mask=mask)
                        finally:
                            mask.close()
                            rgba.close()
                    else:
                        rgb = oriented.convert("RGB")
                finally:
                    if oriented is not source:
                        oriented.close()
        size = _target_size(*rgb.size)
        if size != rgb.size:
            reduced = rgb.resize(size, Image.Resampling.LANCZOS)
            rgb.close()
            return reduced
        return rgb
    except OCRError:
        raise
    except Exception:
        raise OCRError("图片损坏、无法解码或超过图像解压安全上限") from None


def _pdf_image(document, index: int):
    page = bitmap = None
    try:
        page = document[index]
        width, height = page.get_size()
        if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0 or max(width, height) > 100000:
            raise OCRError("PDF页面尺寸无效或过大")
        # 优先200DPI；限制在栅格化前注入，避免先渲染超大页面再缩小。
        scale = min(200 / 72, MAX_DIMENSION / max(width, height), math.sqrt(MAX_PAGE_PIXELS / (width * height)))
        # 留出ceil产生的边界像素，确保渲染面积本身不超过限制。
        scale *= 0.999
        bitmap = page.render(scale=scale)
        pil = bitmap.to_pil()
        try:
            if pil.width * pil.height > MAX_PAGE_PIXELS or max(pil.size) > MAX_DIMENSION:
                raise OCRError("PDF渲染像素超过安全上限")
            return pil.convert("RGB")
        finally:
            pil.close()
    except OCRError:
        raise
    except Exception:
        raise OCRError(f"PDF第{index + 1}页渲染失败，文件可能损坏或加密") from None
    finally:
        if bitmap is not None:
            bitmap.close()
        if page is not None:
            page.close()


def ocr_file(path: str, language: str = "chi_sim+eng") -> dict:
    """返回{text,pages,truncated,warnings}；pages是已尝试识别的页数。

    PDF最多处理前10页，并明确标记截断；单页识别最长15秒、整次识别90秒。
    纯空结果或所有页失败会抛OCRError；部分页失败保留已识别内容并给出警告。
    """
    data, extension = _read_source(path)
    Image, ImageOps, pytesseract, pdfium = _dependencies(language, extension == ".pdf")
    document = None
    messages: list[str] = []
    parts: list[str] = []
    truncated = False
    processed = 0
    chars = 0
    deadline = time.monotonic() + TOTAL_TIMEOUT_SECONDS
    try:
        if extension == ".pdf":
            if b"%PDF-" not in data[:1024]:
                raise OCRError("文件内容不是PDF")
            try:
                document = pdfium.PdfDocument(data)
                total = len(document)
            except Exception:
                raise OCRError("PDF无法打开，文件可能损坏或已加密") from None
            if total < 1:
                raise OCRError("PDF不包含页面")
            count = min(total, MAX_PDF_PAGES)
            if total > MAX_PDF_PAGES:
                truncated = True
                messages.append(f"PDF共有{total}页，本次只识别前{MAX_PDF_PAGES}页；其余页面请拆分后识别")
        else:
            count = 1
        for index in range(count):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                truncated = True
                messages.append("达到90秒总识别时限，剩余页面未处理")
                break
            image = _pdf_image(document, index) if document is not None else _image_from_bytes(data, Image, ImageOps)
            processed += 1
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    truncated = True
                    messages.append("页面预处理达到总时限，剩余内容未识别")
                    break
                try:
                    text = pytesseract.image_to_string(image, lang=language, config="--psm 3", timeout=min(PAGE_TIMEOUT_SECONDS, remaining)).strip()
                except RuntimeError:
                    truncated = True
                    messages.append(f"第{index + 1}页识别超时或失败，未获得该页完整内容")
                    continue
                except Exception:
                    raise OCRError(f"第{index + 1}页识别程序不可用，请检查Tesseract与语言数据") from None
                if not text:
                    messages.append(f"第{index + 1}页未识别到文字，请检查清晰度、方向和语言，空白页也可能没有文字")
                    continue
                section = f"[第{index + 1}页]\n{text}"
                # 包含页码与分隔符，最终输出严格不超过60000字符。
                separator = 2 if parts else 0
                available = MAX_TEXT_CHARS - chars - separator
                if len(section) > available:
                    if available > 0:
                        parts.append(section[:available])
                    truncated = True
                    messages.append("达到60000字符输出上限，后续文字未返回")
                    break
                parts.append(section)
                chars += len(section) + separator
            finally:
                image.close()
        if not parts or not any(part.split("\n", 1)[-1].strip() for part in parts):
            raise OCRError("OCR未识别到文字；" + "；".join(messages or ["请检查文件清晰度、页面方向和语言"]))
        return {"text": "\n\n".join(parts), "pages": processed, "truncated": truncated, "warnings": messages}
    finally:
        if document is not None:
            document.close()
