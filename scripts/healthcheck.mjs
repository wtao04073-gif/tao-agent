/** 存活探测；不把首启待配置或外部模型故障变成重启循环。 */
try {
 const port=Number(process.env.PORT||8080);
 const response=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(5000)});
 process.exit(response.ok?0:1);
}catch{process.exit(1);}
