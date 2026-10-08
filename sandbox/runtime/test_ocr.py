"""OCR策略单元测试：使用合成字节和依赖替身，不在宿主解析不可信文件。"""
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ocr_runtime", Path(__file__).with_name("ocr.py"))
ocr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocr)


class Image:
    closed = False
    def close(self):
        self.closed = True


class Pdf:
    def __init__(self, count):
        self.count = count
        self.closed = False
    def __len__(self):
        return self.count
    def close(self):
        self.closed = True


class OcrTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(ocr, "ROOT", self.root)
        self.root_patch.start()
        (self.root / "input.png").write_bytes(b"trusted synthetic image bytes")
        (self.root / "input.pdf").write_bytes(b"%PDF-1.7\ntrusted synthetic placeholder")
    def tearDown(self):
        self.root_patch.stop()
        self.temp.cleanup()
    def dependencies(self, count=1, text="识别文本", effect=None):
        self.pdf = Pdf(count)
        self.engine = types.SimpleNamespace(image_to_string=unittest.mock.Mock(return_value=text, side_effect=effect))
        return patch.object(ocr, "_dependencies", return_value=(None, None, self.engine, types.SimpleNamespace(PdfDocument=lambda data: self.pdf)))
    def test_image_success_and_per_page_timeout(self):
        image = Image()
        with self.dependencies(), patch.object(ocr, "_image_from_bytes", return_value=image):
            result = ocr.ocr_file("input.png")
        self.assertEqual(result["text"], "[第1页]\n识别文本")
        self.assertEqual(result["pages"], 1)
        self.assertFalse(result["truncated"])
        self.assertTrue(image.closed)
        self.assertLessEqual(self.engine.image_to_string.call_args.kwargs["timeout"], 15)
        self.assertEqual(self.engine.image_to_string.call_args.kwargs["lang"], "chi_sim+eng")
    def test_pdf_is_limited_to_ten_pages_and_closed(self):
        with self.dependencies(count=12), patch.object(ocr, "_pdf_image", side_effect=lambda *a: Image()) as render:
            result = ocr.ocr_file("input.pdf")
        self.assertEqual(render.call_count, 10)
        self.assertEqual(result["pages"], 10)
        self.assertTrue(result["truncated"])
        self.assertIn("12页", result["warnings"][0])
        self.assertTrue(self.pdf.closed)
    def test_empty_ocr_is_not_success(self):
        with self.dependencies(text="  "), patch.object(ocr, "_image_from_bytes", return_value=Image()):
            with self.assertRaisesRegex(ocr.OCRError, "未识别到文字"):
                ocr.ocr_file("input.png")
    def test_timeout_with_partial_text_is_explicit(self):
        with self.dependencies(count=2, effect=["第一页", RuntimeError("timeout")]), patch.object(ocr, "_pdf_image", side_effect=lambda *a: Image()):
            result = ocr.ocr_file("input.pdf")
        self.assertTrue(result["truncated"])
        self.assertIn("第一页", result["text"])
        self.assertIn("第2页", result["warnings"][0])
    def test_output_including_headers_is_bounded(self):
        with self.dependencies(text="文" * 70000), patch.object(ocr, "_image_from_bytes", return_value=Image()):
            result = ocr.ocr_file("input.png")
        self.assertEqual(len(result["text"]), 60000)
        self.assertTrue(result["truncated"])
    def test_exact_limit_does_not_add_extra_separator(self):
        with self.dependencies(count=2, effect=["文" * (60000 - len("[第1页]\n")), "第二页"]), patch.object(ocr, "_pdf_image", side_effect=lambda *a: Image()):
            result = ocr.ocr_file("input.pdf")
        self.assertEqual(len(result["text"]), 60000)
    def test_total_deadline_stops_before_ocr(self):
        with self.dependencies(), patch.object(ocr.time, "monotonic", side_effect=[0, 91]):
            with self.assertRaisesRegex(ocr.OCRError, "90秒"):
                ocr.ocr_file("input.png")
    def test_path_escape_link_and_empty_are_rejected(self):
        outside = self.root.parent / (self.root.name + "-outside.txt")
        outside.write_text("synthetic", encoding="utf-8")
        try:
            (self.root / "link.png").symlink_to(outside)
            for name in [str(outside), "link.png", "missing.png", "input.exe"]:
                with self.assertRaises(ocr.OCRError):
                    ocr._read_source(name)
            (self.root / "empty.png").write_bytes(b"")
            with self.assertRaisesRegex(ocr.OCRError, "非空"):
                ocr._read_source("empty.png")
        finally:
            outside.unlink()
    def test_bad_language_is_rejected_before_importing_dependencies(self):
        for language in ["eng --psm 0", "../../eng", "chi_sim;curl", ""]:
            with self.assertRaisesRegex(ocr.OCRError, "语言参数"):
                ocr._dependencies(language, False)
    def test_missing_python_dependency_is_explicit(self):
        with patch.dict("sys.modules", {"PIL": None}):
            with self.assertRaisesRegex(ocr.OCRError, "缺少OCR组件"):
                ocr._dependencies("eng", False)
    def test_missing_binary_and_language_data_are_explicit(self):
        pil = types.ModuleType("PIL")
        pil.Image, pil.ImageOps = None, None
        engine = types.ModuleType("pytesseract")
        engine.pytesseract = types.SimpleNamespace(tesseract_cmd="")
        with patch.dict("sys.modules", {"PIL": pil, "pytesseract": engine}), patch.object(ocr.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ocr.OCRError, "缺少Tesseract"):
                ocr._dependencies("eng", False)
        with patch.dict("sys.modules", {"PIL": pil, "pytesseract": engine}), patch.object(ocr.shutil, "which", return_value="/usr/bin/tesseract"), patch.object(ocr.subprocess, "run", return_value=types.SimpleNamespace(stdout="eng\n", stderr="")):
            with self.assertRaisesRegex(ocr.OCRError, "chi_sim"):
                ocr._dependencies("chi_sim+eng", False)
    def test_real_synthetic_images_preprocess_when_pillow_available(self):
        try:
            from PIL import Image as PillowImage, ImageOps
        except ImportError:
            self.skipTest("本机无Pillow，仅跳过合成图像预处理测试")
        import io
        for format in ["PNG", "JPEG", "WEBP"]:
            source = PillowImage.new("RGB", (180, 80), "white")
            data = io.BytesIO()
            source.save(data, format=format)
            result = ocr._image_from_bytes(data.getvalue(), PillowImage, ImageOps)
            self.assertEqual(result.size, (180, 80))
            self.assertEqual(result.mode, "RGB")
            result.close()
            source.close()

    def test_pdf_scale_budget_precedes_render(self):
        class Bitmap:
            def to_pil(self):
                return types.SimpleNamespace(width=2000, height=2000, size=(2000, 2000), convert=lambda mode: Image(), close=lambda: None)
            def close(self):
                pass
        page = types.SimpleNamespace(get_size=lambda: (10000, 10000), render=unittest.mock.Mock(return_value=Bitmap()), close=lambda: None)
        result = ocr._pdf_image([page], 0)
        scale = page.render.call_args.kwargs["scale"]
        self.assertLessEqual((10000 * scale) ** 2, ocr.MAX_PAGE_PIXELS)
        result.close()
    def test_target_dimensions_are_bounded(self):
        for width, height in [(8000, 4000), (4000, 8000), (30000, 10), (800, 600)]:
            w, h = ocr._target_size(width, height)
            self.assertLessEqual(w * h, ocr.MAX_PAGE_PIXELS)
            self.assertLessEqual(max(w, h), ocr.MAX_DIMENSION)
        with self.assertRaises(ocr.OCRError):
            ocr._target_size(float("inf"), 100)


if __name__ == "__main__":
    unittest.main()
