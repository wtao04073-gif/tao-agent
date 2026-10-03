/* 执行输出展示：偏好只控制显示，不改变模型的推理模式或计费。 */
(function (global) {
 "use strict";
 function create(options) {
  var doc=options.document||global.document, storage=options.storage, messages=Object.create(null),controls=[],hints=[];
  var preferences={thinking:false,stream:true};
  try {var saved=JSON.parse(storage.getItem("tao.run-display")||"null");if(saved){if(typeof saved.thinking==="boolean")preferences.thinking=saved.thinking;if(typeof saved.stream==="boolean")preferences.stream=saved.stream;}}catch(e){}
  function render(item) {
   if(item.channel==="thinking") {item.node.hidden=!preferences.thinking;item.textNode.textContent=preferences.stream||item.complete?item.text:"思考内容将在生成结束后显示";return;}
   if(item.final) {options.renderAnswer(item.node,item.text);return;}
   item.node.textContent=preferences.stream?item.text:"";
  }
  function sync() {
   controls.forEach(function(c){c.thinking.checked=preferences.thinking;c.stream.checked=preferences.stream;});
   Object.keys(messages).forEach(function(k){render(messages[k]);});
   hints.forEach(function(h){h.node.hidden=!preferences.thinking||h.hasThinking;});
  }
  function set(name,value) {preferences[name]=value;try{storage.setItem("tao.run-display",JSON.stringify(preferences));}catch(e){}sync();}
  function mount(parent) {
   var wrap=doc.createElement("div");wrap.className="run-display-options";var row={};
   [["thinking","显示思考"],["stream","流式输出"]].forEach(function(pair){
    var label=doc.createElement("label"),input=doc.createElement("input"),text=doc.createElement("span");
    input.type="checkbox";input.checked=preferences[pair[0]];input.setAttribute("aria-label",pair[1]);
    input.addEventListener("change",function(){set(pair[0],input.checked);});
    text.textContent=pair[1];label.appendChild(input);label.appendChild(text);wrap.appendChild(label);row[pair[0]]=input;
   });
   wrap.title="仅展示模型接口返回的思考内容；开关不改变模型推理模式";parent.appendChild(wrap);controls.push(row);
  }
  function begin(bot) {
   var hint=doc.createElement("div");hint.className="thinking-placeholder";hint.textContent="等待模型返回可展示的思考内容…";hint.hidden=!preferences.thinking;bot.appendChild(hint);hints.push({node:hint,bot:bot,hasThinking:false});
  }
  function itemFor(ev,channel,bot) {
   var key=(ev.taskId||"")+":"+(ev.messageId||"legacy")+":"+channel, item=messages[key];if(item)return item;
   var node,textNode;
   if(channel==="thinking") {
    bot=bot||options.currentBubble();node=doc.createElement("details");node.className="thinking-panel";
    var summary=doc.createElement("summary");summary.textContent="思考";textNode=doc.createElement("div");textNode.className="thinking-content";
    node.appendChild(summary);node.appendChild(textNode);bot.appendChild(node);
    hints.forEach(function(h){if(h.bot===bot){h.hasThinking=true;h.node.hidden=true;}});
   }else node=bot?bot.querySelector("p"):options.answerNode();
   item={node:node,textNode:textNode,channel:channel,text:"",final:false};messages[key]=item;return item;
  }
  function consume(ev,bot) {
   if(["assistant_delta","thinking_delta","message_progress","assistant_message"].indexOf(ev.type)<0)return false;
   var channel=ev.type==="thinking_delta"?"thinking":ev.channel||"answer", item=itemFor(ev,channel,bot);
   if(item.final)return true;
   if(ev.type==="assistant_message") {item.text=ev.text||"";item.final=true;render(item);if(!bot&&options.answerFinished)options.answerFinished();return true;}
   if(ev.type==="message_progress") {item.complete=!!ev.complete;if(ev.complete||ev.text.length>=item.text.length)item.text=ev.text;}
   else if(typeof ev.offset==="number") {
    // 从快照恢复后忽略重叠增量；缺口等待下一份累积快照，不拼出残缺答案。
    if(ev.offset<=item.text.length){var skip=item.text.length-ev.offset;if(skip<ev.delta.length)item.text+=ev.delta.slice(skip);}
   }else item.text+=ev.delta;
   render(item);if(options.changed)options.changed();return true;
  }
  function history(bot,events) {events.forEach(function(ev){if(ev.type==="message_progress"||(ev.type==="assistant_message"&&ev.messageId))consume(ev,bot);});}
  function finish() {hints.forEach(function(h){if(!h.hasThinking)h.node.textContent="本轮模型未返回可展示的思考内容";});}
  function reset() {messages=Object.create(null);hints=[];}
  return {mount:mount,begin:begin,consume:consume,history:history,finish:finish,reset:reset,set:set,preferences:preferences};
 }
 global.ChatRunDisplay={create:create};
 if(typeof module!=="undefined"&&module.exports)module.exports={create:create};
})(typeof window!=="undefined"?window:globalThis);
