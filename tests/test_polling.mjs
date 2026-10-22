// Browser-only regression: mocked HTTP, synthetic media, no ComfyUI or GPU required.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const { chromium } = await import(process.env.AVA_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.AVA_PLAYWRIGHT_MODULE).href : "@playwright/test");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ava-player-test-"));
const mediaPath = path.join(temporary, "clip.mp4");
const encoded = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=128x128:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mediaPath]);
assert.equal(encoded.status, 0, String(encoded.stderr));
const media = await fs.readFile(mediaPath);
const agent = await fs.readFile(path.join(root, "web/agent.js"), "utf8");
const css = await fs.readFile(path.join(root, "web/agent.css"), "utf8");
const now = Date.now()/1000;
const scene = { id:"scene", projectId:"project", episodeId:"episode-1", name:"Scene", script:"Open, speak, then smile.", summary:"Three beats.", references:[], paused:false,
  settings:{provider:"h3",aspectRatio:"16:9",megapixels:2,steps:8,seed:-1,refImageSize:"match"}, clips:[
    {id:"one",title:"Saved clip",prompt:"Open the door.",outline:"Open.",duration:2,actualDuration:2,referenceIds:[],transition:"first",continuityMode:"auto",status:"complete",takeId:"take-one",video:{path:"first.mp4"},versions:[],timing:{submittedAt:now-40,completedAt:now-10}},
    {id:"two",title:"Sampling clip",prompt:"Speak.",outline:"Speak.",duration:5,referenceIds:[],transition:"continue",continuityMode:"auto",status:"rendering",takeId:"take-two",versions:[],timing:{submittedAt:now-20,renderStartedAt:now-15,elapsedSeconds:20,remainingSeconds:50,etaKind:"sampling",sampling:{value:2,total:8}}},
    {id:"three",title:"Following clip",prompt:"",outline:"Smile.",duration:5,referenceIds:[],transition:"continue",continuityMode:"auto",status:"awaiting-approval",versions:[],timing:{}}
  ]};
const project={id:"project",name:"Film",library:[],episodes:[{id:"episode-1",name:"Episode 1"}]};
const state=()=>({projects:[project],project,episodes:project.episodes,selectedEpisodeId:"episode-1",scenes:[scene],videos:[{...scene.clips[0],episodeName:"Episode 1",sceneName:"Scene"}],planner:{model:""},helper:{connected:true,models:[],lastSeen:Date.now()/1000},storage:"/test"});
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||"msedge"});
const page=await browser.newPage({viewport:{width:1400,height:1000}});
const errors=[];
let mediaRequests=0, savedPrompt;
page.on("pageerror", error=>errors.push(error.message));
await page.addInitScript(()=>{
  localStorage.setItem("ava-project","project");localStorage.setItem("ava-scene","scene");localStorage.setItem("ava-episode","episode-1");localStorage.setItem("ava-section","agent");
  const interval=window.setInterval.bind(window);
  window.setInterval=(fn,delay,...args)=>interval(fn,delay===5000?80:delay,...args);
});
await page.route("http://ava.test/**",async route=>{
  const url=new URL(route.request().url());
  const respond=(body,contentType="application/json")=>route.fulfill({status:200,contentType,body:typeof body==="string"||Buffer.isBuffer(body)?body:JSON.stringify(body)});
  if(url.pathname==="/")return respond('<title>Player test</title><div id="sidebar" style="height:100vh"></div><link rel="stylesheet" href="/agent.css"><script type="module" src="/extensions/ava/agent.js"></script>',"text/html");
  if(url.pathname==="/scripts/app.js")return respond("export const app={extensionManager:{registerSidebarTab(tab){tab.render(document.querySelector('#sidebar'))}},registerExtension(ext){ext.setup()}};","text/javascript");
  if(url.pathname==="/scripts/api.js")return respond("export const api={fetchApi:(url,options)=>fetch(url,options),apiURL:url=>url};","text/javascript");
  if(url.pathname==="/extensions/ava/agent.js")return respond(agent,"text/javascript");
  if(url.pathname.endsWith("/agent.css"))return respond(css,"text/css");
  if(url.pathname==="/ava-agent/state")return respond(state());
  if(url.pathname==="/ava-agent/scene")return respond(scene);
  if(url.pathname==="/ava-agent/media"){mediaRequests++;return respond(media,"video/mp4");}
  if(url.pathname==="/ava-agent/action"){
    const body=route.request().postDataJSON();
    if(body.action==="saveClip"){savedPrompt=body.prompt;scene.clips.find(c=>c.id===body.clipId).prompt=body.prompt;}
    return respond({scene});
  }
  throw new Error("Unexpected request: "+url);
});
try{
  await page.goto("http://ava.test");
  const player=page.locator(".ava-clip video").first();
  await player.waitFor();
  await player.evaluate(async video=>{
    if(video.readyState<1)await new Promise(resolve=>video.addEventListener("loadedmetadata",resolve,{once:true}));
    video.muted=true;video.loop=true;await video.play();
    window.originalVideo=video;window.videoReloads=0;
    for(const event of ["emptied","loadstart"])video.addEventListener(event,()=>window.videoReloads++);
  });
  const requests=mediaRequests;
  const assertPlayer=async()=>{
    assert.equal(await player.evaluate(video=>video===window.originalVideo),true,"polling/reconciliation must retain the original player");
    assert.equal(await player.evaluate(video=>video.paused),false,"the existing player must keep playing");
    assert.equal(await page.evaluate(()=>window.videoReloads),0,"unchanged video must not reload");
    assert.equal(mediaRequests,requests,"temporary render trees must not fetch another copy of the media");
  };
  scene.clips[1].timing.sampling.value=5;
  scene.clips[1].timing.remainingSeconds=15;
  await page.locator(".ava-live-status").getByText(/Sampling · 5 \/ 8/).waitFor();
  await assertPlayer();
  assert.equal(await page.getByText("Estimated finish",{exact:true}).count(),0);
  assert.equal(await page.locator(".ava-live-status").getByText("Sampling ETA",{exact:true}).count(),1);
  scene.clips[0].error="A changed status message must not replace the video.";
  scene.clips[1].status="saving";scene.clips[1].timing.remainingSeconds=null;
  await page.locator(".ava-live-status").getByText("Sampling finished",{exact:true}).waitFor();
  await assertPlayer();
  delete scene.clips[0].error;
  scene.clips[1].status="complete";scene.clips[1].timing.completedAt=Date.now()/1000;
  scene.planning={id:"auto",automatic:true,status:"running",startedAt:Date.now()/1000,inputs:{action:"planPrompt",clipId:"three"}};
  await page.getByRole("status").filter({hasText:"understanding the last frame"}).waitFor();
  assert.notEqual(await page.locator(".ava-workspace").getAttribute("aria-busy"),"true");
  assert.equal(await page.locator("main").evaluate(el=>el.inert),false,"automatic optimization must leave the video controls usable");
  await assertPlayer();
  scene.planning.status="complete";
  scene.clips[2].prompt="Start with the actor beside the open door, then smile.";
  scene.clips[2].frameAnalysis="Actor is already at the door. Continue from that observed position.";
  const third=page.locator(".ava-clip").filter({has:page.getByRole("heading",{name:"3. Following clip",exact:true})});
  await page.waitForFunction(()=>[...document.querySelectorAll('textarea[aria-label="Editable video prompt"]')].some(el=>el.value.includes("beside the open door")));
  await assertPlayer();
  await third.getByLabel("Editable video prompt").fill("User revised the optimized prompt.");
  await third.getByRole("button",{name:"Save prompt & references",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector(".ava-workspace").getAttribute("aria-busy")==="false");
  assert.equal(savedPrompt,"User revised the optimized prompt.","reconciled buttons must read the current, visible inputs");
  await assertPlayer();
  assert.deepEqual(errors,[]);
  console.log("UI regression passed: sampling updates, saving/completion, automatic next-prompt optimization, adjacent status changes and saving edits all preserve video playback without another media request.");
}finally{
  await browser.close();
  assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith("ava-player-test-"));
  await fs.rm(temporary,{recursive:true,force:true});
}
