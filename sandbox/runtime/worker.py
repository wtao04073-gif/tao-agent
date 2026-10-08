"""运行于隔离环境内部；不导入服务配置，不接受宿主路径。JSONL控制协议。"""
import asyncio
import base64
import codecs
import json
import os
from pathlib import Path
import resource
import signal
import shutil
import stat
import socket
import sys
import time
import uuid

ROOT = Path('/workspace')
MAX_FILE = 10 * 1024 * 1024
MAX_TEXT = 64000
browser = None
page = None
playwright = None


def path_for(raw, *, output=False):
    if not isinstance(raw, str) or '\x00' in raw:
        raise ValueError('文件路径无效')
    path = Path(raw) if raw.startswith('/workspace/') else ROOT / raw
    if any(item.is_symlink() for item in [path, *path.parents] if item != ROOT.parent):
        raise ValueError('沙箱文件操作不允许符号链接')
    resolved = path.resolve()
    base = ROOT.resolve()
    if not resolved.is_relative_to(base) or resolved == base and output:
        raise ValueError('只允许访问沙箱工作目录')
    if output and not (resolved.is_relative_to(base / 'output') or resolved.is_relative_to(base / 'downloads')):
        raise ValueError('请先将交付文件保存到 output 或 downloads 目录')
    return resolved


def emit(value, sink):
    sink(json.dumps(value, ensure_ascii=False) + '\n')


async def bridge(reader, writer):
    """仅本地隔离运行时使用：把沙箱内代理连接送至专属 Unix 出网通道。"""
    try:
        remote_reader, remote_writer = await asyncio.open_unix_connection('/egress.sock')
        async def pump(src, dst):
            try:
                while chunk := await src.read(65536):
                    dst.write(chunk)
                    await dst.drain()
            finally:
                dst.close()
        await asyncio.gather(pump(reader, remote_writer), pump(remote_reader, writer))
    except Exception:
        writer.close()


async def ensure_browser():
    global browser, page, playwright
    if browser is not None:
        return
    from playwright.async_api import async_playwright
    playwright = await async_playwright().start()
    args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-quic', '--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
    if os.environ.get('LD_PRELOAD') == '/opt/venv/libproc-exe-compat.so':
        args += ['--single-process', '--no-zygote', '--disable-gpu', '--in-process-gpu']
    proxy = {'server': 'http://127.0.0.1:3128', 'bypass': '<-loopback>'} if Path('/egress.sock').exists() else None
    if os.environ.get('TAO_BROWSER_ENGINE') == 'firefox':
        browser = await playwright.firefox.launch(headless=True, firefox_user_prefs={'media.peerconnection.enabled': False, 'network.http.http3.enable': False}, **({'proxy': proxy} if proxy else {}))
    else:
        browser = await playwright.chromium.launch(headless=True, args=args, **({'proxy': proxy} if proxy else {}))
    context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True, service_workers='block')
    page = await context.new_page()
    page.set_default_timeout(15000)
    async def save_download(download):
        name = Path(download.suggested_filename).name.replace('/', '_').replace('\\', '_')[:120]
        await download.save_as(ROOT / 'downloads' / (uuid.uuid4().hex[:8] + '-' + name))
    page.on('download', save_download)


async def dispatch(a, sink):
    operation = a.get('op')
    if operation == 'health':
        import importlib.util
        return {'python': True, 'node': bool(shutil.which('node')), 'browser': importlib.util.find_spec('playwright') is not None, 'workspace': '/workspace'}
    if operation == 'execute':
        code = a.get('code', '')
        if not isinstance(code, str) or len(code.encode()) > 64000:
            raise ValueError('代码超过64KB限制')
        language = a.get('language', 'python')
        executable = {'python': [sys.executable, '-u', '-c'], 'javascript': [shutil.which('node') or '/usr/bin/node', '--max-old-space-size=256', '-e'], 'bash': ['/bin/bash', '--noprofile', '--norc', '-c']}.get(language)
        if executable is None:
            raise ValueError('不支持的语言')
        timeout = min(120, max(1, int(a.get('timeoutSeconds', 30))))
        cwd = path_for(a.get('cwd', '.'))
        env = dict(os.environ)
        env.update({'HOME': '/workspace', 'TMPDIR': '/tmp', 'MPLCONFIGDIR': '/workspace/.matplotlib', 'PYTHONUNBUFFERED': '1', 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1', 'MPLBACKEND': 'Agg'})
        p = await asyncio.create_subprocess_exec(*executable, code, cwd=cwd, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        output = {'stdout': '', 'stderr': ''}
        truncated = False
        async def read(stream, channel):
            nonlocal truncated
            decoder = codecs.getincrementaldecoder('utf8')('replace')
            while chunk := await stream.read(4096):
                text = decoder.decode(chunk)
                remaining = MAX_TEXT - len(output[channel])
                if remaining > 0:
                    output[channel] += text[:remaining]
                    emit({'event': 'output', 'channel': channel, 'text': text[:min(remaining, 2048)]}, sink)
                if len(text) > remaining:
                    truncated = True
        timed_out = False
        try:
            await asyncio.wait_for(asyncio.gather(read(p.stdout, 'stdout'), read(p.stderr, 'stderr'), p.wait()), timeout=timeout)
        except asyncio.TimeoutError:
            timed_out = True
        finally:
            # 同一命令产生的后台子进程也应被回收。
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await p.wait()
        return {**output, 'exitCode': p.returncode, 'timedOut': timed_out, 'truncated': truncated}
    if operation in ('write', 'read', 'list', 'export'):
        p = path_for(a.get('path', '.'), output=operation == 'export')
        if operation == 'write':
            if p == ROOT or p.is_dir():
                raise ValueError('请选择文件路径')
            data = base64.b64decode(a.get('data', ''), validate=True)
            if len(data) > MAX_FILE:
                raise ValueError('文件超过10MB')
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            return {'path': str(p), 'bytes': len(data)}
        if operation == 'list':
            return {'files': [{'name': f.name, 'directory': f.is_dir(), 'bytes': f.stat().st_size if f.is_file() else 0} for f in sorted(p.iterdir())[:200] if not f.is_symlink()]}
        if not p.is_file() or p.is_symlink() or p.stat().st_size > MAX_FILE:
            raise ValueError('不是可读取的普通文件或超过10MB')
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError('不是可导出的普通文件')
            data = source.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise ValueError('文件超过10MB')
        if operation == 'export':
            return {'name': p.name, 'data': base64.b64encode(data).decode(), 'bytes': len(data)}
        return {'path': str(p), 'text': data[:MAX_TEXT].decode('utf8', errors='replace'), 'truncated': len(data) > MAX_TEXT}
    if operation == 'browser':
        await ensure_browser()
        action = a.get('action', 'observe')
        if action == 'navigate':
            from urllib.parse import urlparse
            url = a.get('url', '')
            parsed = urlparse(url)
            if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError('仅允许无凭据的 HTTP(S) 网页地址')
            await page.goto(url, wait_until='domcontentloaded', timeout=30000)
        elif action == 'click':
            await page.locator(a['selector']).first.click()
        elif action == 'fill':
            await page.locator(a['selector']).first.fill(a.get('value', ''))
        elif action == 'press':
            await page.keyboard.press(a['key'])
        elif action == 'upload':
            await page.locator(a['selector']).first.set_input_files(str(path_for(a['path'])))
        elif action == 'scroll':
            await page.mouse.wheel(0, max(-3000, min(3000, int(a.get('distance', 800)))))
        elif action == 'back':
            await page.go_back(wait_until='domcontentloaded', timeout=20000)
        elif action not in ('observe', 'screenshot'):
            raise ValueError('不支持的浏览器操作')
        await page.wait_for_timeout(min(3000, max(0, int(a.get('waitMs', 500)))))
        shot = ROOT / 'output' / ('网页截图-' + uuid.uuid4().hex[:12] + '.png')
        await page.screenshot(path=str(shot), full_page=False)
        # 网页内容是不可信外部数据，客户端工具描述会向模型明确这一点。
        text = (await page.locator('body').inner_text(timeout=5000))[:12000] if await page.locator('body').count() else ''
        controls = await page.locator('a,button,input,select,textarea').evaluate_all("els => els.slice(0,60).map(e=>({tag:e.tagName,text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').slice(0,100),id:e.id,name:e.name||'',type:e.type||''}))")
        return {'url': page.url, 'title': await page.title(), 'text': text, 'controls': controls, 'screenshot': str(shot), 'notice': '网页可能要求登录或验证；不会绕过验证码。截图代表当前真实页面。'}
    raise ValueError('未知沙箱操作')


async def serve_request(raw, sink):
    request_id = None
    try:
        a = json.loads(raw)
        request_id = a.get('id')
        result = await dispatch(a, sink)
        emit({'id': request_id, 'result': result}, sink)
    except Exception as error:
        emit({'id': request_id, 'error': str(error).split('Call log:')[0].split('Browser logs:')[0][:1500]}, sink)


async def main():
    for name in ['output', 'downloads', 'inputs']:
        (ROOT / name).mkdir(parents=True, exist_ok=True)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))
    bridge_server = await asyncio.start_server(bridge, '127.0.0.1', 3128) if Path('/egress.sock').exists() else None
    if len(sys.argv) > 1 and sys.argv[1] == '--serve':
        async def client(reader, writer):
            try:
                raw = await reader.readline()
                await serve_request(raw, lambda s: writer.write(s.encode()))
                await writer.drain()
            finally:
                writer.close()
        server = await asyncio.start_unix_server(client, '/tmp/tao-runtime.sock', limit=16*1024*1024)
        async with server:
            await server.serve_forever()
    else:
        while raw := await asyncio.to_thread(sys.stdin.readline):
            await serve_request(raw, lambda s: (sys.stdout.write(s), sys.stdout.flush()))
    if browser is not None:
        await browser.close()
    if playwright is not None:
        await playwright.stop()
    if bridge_server:
        bridge_server.close()


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--client':
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(130)
            s.connect('/tmp/tao-runtime.sock')
            s.sendall(base64.b64decode(sys.argv[2]) + b'\n')
            while data := s.recv(65536):
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
    else:
        asyncio.run(main())
