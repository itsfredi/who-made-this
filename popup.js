const ki=document.getElementById("ki"),bs=document.getElementById("bs"),bc=document.getElementById("bc"),toast=document.getElementById("toast"),dot=document.getElementById("dot"),stxt=document.getElementById("stxt");
chrome.runtime.sendMessage({action:"getSettings"},r=>{if(r?.sauceNaoKey){ki.value=r.sauceNaoKey;setDot(true);}});
bs.onclick=()=>{const k=ki.value.trim();if(!k){show("enter a key first",false);return;}chrome.runtime.sendMessage({action:"saveSettings",sauceNaoKey:k},()=>{setDot(true);show("✓ saved",true);});};
bc.onclick=()=>{ki.value="";chrome.runtime.sendMessage({action:"saveSettings",sauceNaoKey:""},()=>{setDot(false);show("cleared",true);});};
function setDot(on){dot.className="dot "+(on?"on":"off");stxt.textContent=on?"SauceNAO key active (300/day)":"No key — using free tier (100/day)";}
function show(msg,ok){toast.textContent=msg;toast.className="toast "+(ok?"tok":"terr");toast.style.display="block";setTimeout(()=>toast.style.display="none",2200);}
