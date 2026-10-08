/** 仅用于面向用户的工具摘要：限制体积，隐藏凭证、路径与大块内容。 */
export function toolSummary(value: unknown): string {
 let budget=3000;
 function clean(v: unknown, depth=0, key=""): unknown {
  if (/password|secret|token|api.?key|authorization|cookie|credential|private.?key/i.test(key)) return "<REDACTED>";
  if (/^(rows|blocks|data|bytes|base64|body|content)$/i.test(key)) return Array.isArray(v)?`[${v.length} 项内容已省略]`:"[内容已省略]";
  if (budget<=0 || depth>4) return "[已截断]";
  if (typeof v==="string") {
   let s=v.replace(/(?:Bearer\s+\S+|(?:sk-|ark-|github_pat_|ghp_)[A-Za-z0-9_-]+)/gi,"<REDACTED>")
    .replace(/((?:password|token|secret|api.?key|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,"$1<REDACTED>")
    .replace(/https?:\/\/[^\s"<>]+/gi,"[链接已隐藏]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s"<>]+[\\/])+[^\s"<>]*/g,"[路径已隐藏]");
   if (/path/i.test(key))s="[路径已隐藏]";
   const n=Math.min(500,budget);budget-=Math.min(s.length,n);return s.length>n?s.slice(0,n)+"…":s;
  }
  if (v===null || typeof v==="number" || typeof v==="boolean")return v;
  if (Array.isArray(v))return [...v.slice(0,3).map(x=>clean(x,depth+1)),...(v.length>3?[`其余 ${v.length-3} 项省略`]:[])];
  if (v && typeof v==="object")return Object.fromEntries(Object.entries(v).slice(0,16).map(([k,x])=>[k,clean(x,depth+1,k)]));
  return null;
 }
 return JSON.stringify(clean(value),null,2).slice(0,4096);
}
