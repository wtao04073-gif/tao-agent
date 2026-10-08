import {it,expect,vi} from 'vitest';
vi.mock('../src/admin-network.ts',()=>({outboundFetch:()=>async()=>new Response('<!doctype html><html><title>Example Domain</title><style>hidden-css</style><div><h1>Example Domain</h1><p>Public content.</p><script>hidden-script</script></div>',{headers:{'content-type':'text/html'}})}));
import {webReaderTool} from '../src/web-reader.ts';
it('公开网页省略head/body标签时仍提取正文并移除脚本样式',async()=>{const r=await webReaderTool({ALLOW_OUTBOUND_NETWORK:'true'})[0]!.execute({args:{url:'https://example.com'},signal:AbortSignal.timeout(1000),report:()=>{}} as any);const data=JSON.parse(r.text);expect(data.text).toContain('Public content.');expect(data.title).toBe('Example Domain');expect(data.text).not.toContain('hidden-script');expect(data.text).not.toContain('hidden-css');});
it('出网未授权时不注册网页读取工具',()=>{expect(webReaderTool({})).toEqual([]);});
