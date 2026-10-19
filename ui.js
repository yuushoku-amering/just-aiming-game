'use strict';
// 澪 · 2026-10-20。视觉与菜单交互层；保留 game.js 的谱面、计分和命中判定。
(() => {
  const el = id => document.getElementById(id);
  const menu = el('menu');
  const modes = ['靶区', '封面', 'MV'];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt = t => Math.floor(Math.max(0,t)/60)+':'+String(Math.floor(Math.max(0,t)%60)).padStart(2,'0');
  const setText = (id,value) => { const n=el(id); if(n.textContent!==String(value)) n.textContent=value; };
  let lastMenuKey='';
  const visible = id => el(id).style.display === 'flex';
  function syncMenu() {
    const song=currentSong(), chart=window.CHARTS?.[song?.id];
    const key=[MENU.idx,MENU.diff,S.screenMode].join('/');
    if (key===lastMenuKey) return;
    lastMenuKey=key;
    setText('song-title',song?.title || '—');
    setText('song-artist',song?.artist || '');
    setText('track-count',String(MENU.idx+1).padStart(2,'0')+' / '+String(MENU.songs.length).padStart(2,'0'));
    setText('song-bpm',chart ? Math.round(chart.bpm)+' BPM' : '— BPM');
    setText('song-duration',chart ? fmt(chart.duration) : '—');
    setText('song-targets',chart ? chart.events.filter(e=>(e.d||1)<=MENU.diff+1).length+' 个目标' : '');
    setText('difficulty-note',['更宽裕的瞄准时间','标准节奏与密度','更紧凑的目标节奏'][MENU.diff]);
    setText('screen-mode','后屏 · '+modes[S.screenMode]);
    document.querySelectorAll('[data-diff]').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.diff===MENU.diff)));
  }
  function backToMenu() {
    S.running=false; S.paused=true; S.holding=null;
    clearTimeout(PREVIEW.timer); audio.pause(); SCREEN.video?.pause();
    document.exitPointerLock?.();
    for(const id of ['pause','end','settings']) el(id).style.display='none';
    lastMenuKey=''; syncMenu();
  }
  function cycleScreen(){S.screenMode=(S.screenMode+1)%3;if(S.screenMode===2&&typeof ensureVideo==='function')ensureVideo();lastMenuKey='';syncMenu();}
  el('song-prev').onclick=()=>switchSong(-1);
  el('song-next').onclick=()=>switchSong(1);
  document.querySelectorAll('[data-diff]').forEach(b=>b.onclick=()=>{MENU.diff=+b.dataset.diff;syncMenu();});
  el('play').onclick=()=>startGame();
  el('open-settings').onclick=()=>openSensPanel();
  el('screen-mode').onclick=cycleScreen;
  el('to-menu').onclick=backToMenu;
  el('end-menu').onclick=backToMenu;
  el('close-settings').onclick=()=>{closeSensPanel();if(S.running)el('pause').style.display='flex';};

  // Canvas 的旧鼠标区域不能接收菜单、设置或结果弹层的点击。
  window.addEventListener('mousedown',e=>{
    if(!S.running || e.target.closest?.('.overlay')) e.stopPropagation();
  },true);
  window.addEventListener('keydown',e=>{
    const inDialog=visible('settings')||visible('pause')||visible('end');
    if(inDialog){
      e.stopImmediatePropagation();
      if(e.key==='Escape' && visible('settings')){e.preventDefault();el('close-settings').click();}
      else if(e.key==='Escape' && visible('pause')){e.preventDefault();resumeGame();}
      else if(e.key==='Enter' && visible('settings')){e.preventDefault();el('apply-sens').click();}
      return;
    }
    if(!S.running){
      if(e.target.closest?.('button,input')){
        if(e.key===' '||e.key==='Enter') e.stopImmediatePropagation();
        return;
      }
      if(e.key.toLowerCase()==='m'){e.preventDefault();e.stopImmediatePropagation();cycleScreen();return;}
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' '].includes(e.key)) e.preventDefault();
    }
  },true);
  document.addEventListener('pointerlockchange',()=>{
    if(visible('settings')) el('pause').style.display='none';
    if(!document.pointerLockElement) S.holding=null;
  });

  const oldStart=startGame;
  startGame=function(){
    if(visible('settings'))return;
    MENU.pendingIdx=null;MENU.flip=0;
    el('play').blur(); oldStart();
    menu.style.display='none';document.body.dataset.scene='game';
  };
  const oldOpenSettings=openSensPanel;
  openSensPanel=function(){oldOpenSettings();el('pause').style.display='none';};

  // 菜单沿用角色举专辑与翻面动画，文字与按钮交给原生 HTML。
  renderMenu=function(dt){
    document.body.dataset.scene='menu';
    menu.style.display=visible('end')?'none':'flex';el('hud').style.display='none';
    const t=performance.now()/1000;
    MENU.flip=Math.max(0,(MENU.flip||0)-dt*2.4);
    if(MENU.pendingIdx!=null && MENU.flip<.5){MENU.idx=MENU.pendingIdx;MENU.pendingIdx=null;previewSong(currentSong());}
    syncMenu();
    ctx.fillStyle='#08111e';ctx.fillRect(0,0,W,H);
    const spring=currentSong()?.id==='haru';
    const glow=ctx.createRadialGradient(W*.73,H*.4,0,W*.73,H*.4,W*.65);
    glow.addColorStop(0,spring?'#57445955':'#315d7a70');glow.addColorStop(1,'#08111e00');
    ctx.fillStyle=glow;ctx.fillRect(0,0,W,H);
    const wash=ctx.createLinearGradient(0,0,W,0);wash.addColorStop(0,'#060e19cc');wash.addColorStop(.48,'#08111e00');
    ctx.fillStyle=wash;ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='#a0c8dd12';ctx.lineWidth=1;
    for(const r of [.25,.31,.39]){ctx.beginPath();ctx.arc(W*.72,H*.45,H*r,-Math.PI*.83,Math.PI*.76);ctx.stroke();}
    ctx.strokeStyle='#9edee50d';ctx.beginPath();ctx.moveTo(W*.53,H*.12);ctx.lineTo(W*.53,H*.84);ctx.stroke();
    for(const p of MENU.petals){
      if(!reducedMotion){p.y+=p.vy*dt*.4;p.x+=Math.sin(t+p.ph)*dt*3;}
      if(p.y>H){p.y=0;p.x=Math.random()*W;}
      ctx.fillStyle=spring?'#efc8dd38':'#b4dbea30';
      ctx.beginPath();ctx.ellipse(p.x,p.y,p.r*.5,p.r*.25,p.a,0,Math.PI*2);ctx.fill();
    }
    const sh=Math.min(H*.89,W*.64),sw=sh*(814/1208);
    const sx=W*.735-sw/2+(reducedMotion?0:Math.sin(t*.7)*2),sy=H*.96-sh;
    const floor=ctx.createRadialGradient(W*.735,H*.93,0,W*.735,H*.93,sw*.6);
    floor.addColorStop(0,'#8cc8d222');floor.addColorStop(1,'#8cc8d200');
    ctx.fillStyle=floor;ctx.fillRect(sx-sw*.2,H*.82,sw*1.4,H*.16);
    const twist=reducedMotion?0:MENU.flip||0;
    if(herAlbumImg.complete&&herAlbumImg.naturalWidth){
      ctx.save();ctx.translate(sx+sw*.55,sy+sh*.62);ctx.rotate(-.035*twist);
      ctx.translate(-(sx+sw*.55)+10*twist,-(sy+sh*.62)-2*twist);
      ctx.drawImage(herAlbumImg,sx,sy,sw,sh);ctx.restore();
      drawAlbum(sx+10*twist,sy-2*twist,sw,sh);
    }
  };

  const originalRoom=drawRoom;
  drawRoom=function(B){
    originalRoom(B);
    // 固定在世界里的舞台边缘与地面刻度，帮助转向时保持空间感。
    for(const side of [-1,1]){
      line3(B,[side*8.8,.03,-2],[side*8.8,.03,-17],'rgba(122,199,211,.3)',2);
      line3(B,[side*8.8,.03,-17],[side*6.8,.03,-17],'rgba(122,199,211,.3)',2);
      for(let z=-4;z>=-16;z-=3)line3(B,[side*8.55,.04,z],[side*8.8,.04,z],'rgba(167,215,225,.28)',2);
    }
    for(const x of [-8.5,8.5])line3(B,[x,.7,-17.9],[x,6.3,-17.9],'rgba(114,170,194,.23)',3);
  };
  const originalMedia=drawMedia;
  drawMedia=function(B){
    originalMedia(B);
    // 整块屏幕最后覆一层暗色，避免逐三角透明合成产生斜向接缝。
    const videoReady=S.screenMode===2&&SCREEN.video&&SCREEN.video.readyState>=2;
    if(!videoReady&&!(SCREEN.cover.complete&&SCREEN.cover.naturalWidth))return;
    const halfW=5.2*(videoReady?16/9:1)/2,z=-ROOM.d+.08;
    const q=[project3(-halfW,.8,z,B),project3(halfW,.8,z,B),project3(halfW,6,z,B),project3(-halfW,6,z,B)];
    if(q.every(Boolean)){
      ctx.save();ctx.beginPath();ctx.moveTo(q[0].x,q[0].y);q.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();
      ctx.fillStyle='rgba(4,12,24,.28)';ctx.fill();ctx.restore();
    }
  };

  drawTargets=function(B){
    const k=(W/2)/Math.tan(FOVH/2*RAD);
    const list=S.targets.filter(g=>!g.hit).map(g=>({g,p:project3(g.x,g.y,g.z,B)})).filter(o=>o.p).sort((a,b)=>b.p.z-a.p.z);
    for(const {g,p} of list){
      const r=g.rw/p.z*k,hold=g.type==='hold';
      const col=hold?'244,199,112':g.fast?'255,145,164':'148,229,244';
      const remain=clamp(1-(S.t-g.born)/g.life,0,1);
      const progress=hold?clamp(g.progress/g.dur,0,1):remain;
      ctx.save();ctx.translate(p.x,p.y);
      ctx.fillStyle='rgba(4,15,26,.83)';ctx.strokeStyle='rgba(0,5,12,.85)';ctx.lineWidth=6;
      ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.shadowColor=`rgba(${col},.4)`;ctx.shadowBlur=12;
      ctx.strokeStyle=`rgba(${col},.96)`;ctx.lineWidth=2.5;ctx.stroke();ctx.shadowBlur=0;
      ctx.beginPath();ctx.arc(0,0,r*1.17,-Math.PI/2,-Math.PI/2+Math.PI*2*progress);
      ctx.strokeStyle=`rgba(${col},.9)`;ctx.lineWidth=hold?4:2;ctx.stroke();
      ctx.fillStyle=`rgba(${col},${hold?.2+.7*progress:.85})`;
      ctx.beginPath();ctx.arc(0,0,r*(hold?.22:.26),0,Math.PI*2);ctx.fill();
      if(hold){
        ctx.strokeStyle=`rgba(${col},.55)`;ctx.lineWidth=1.5;
        for(const s of [-1,1]){ctx.beginPath();ctx.moveTo(s*r*.5,-r*.2);ctx.lineTo(s*r*.5,r*.2);ctx.stroke();}
      }
      ctx.restore();
    }
  };
  drawCrosshair=function(){
    const x=W/2,y=H/2;
    ctx.save();ctx.translate(x,y);
    for(const [color,width] of [['#02060ce6',4],['#f1fbff',1.7]]){
      ctx.strokeStyle=color;ctx.lineWidth=width;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ctx.beginPath();ctx.moveTo(dx*5,dy*5);ctx.lineTo(dx*11,dy*11);ctx.stroke();}
    }
    ctx.fillStyle='#f1fbff';ctx.fillRect(-1,-1,2,2);ctx.restore();
  };
  const originalRender=render;
  render=function(){
    originalRender();el('hud').style.display='block';menu.style.display='none';document.body.dataset.scene='game';
    // 与原 HUD 在同一帧更新；文本没变化时不写 DOM。
    setText('score',S.score.toLocaleString('en-US'));
    setText('sub','命中 '+S.hits+'　/　漏 '+S.misses);
    setText('streak',String(S.combo).padStart(2,'0')+' ×');
    setText('playing-title',currentSong().title+' · '+DIFF_NAMES[MENU.diff]);
    setText('elapsed',fmt(nowT()));
    el('song-progress-fill').style.width=(clamp(nowT()/CHART.duration,0,1)*100)+'%';
    setText('hint','M 后屏 · '+modes[S.screenMode]+'　/　Esc 暂停　/　'+BUILD);
    const beat=Math.floor(nowT()/BEAT)%4;
    [...el('beat-dots').children].forEach((dot,i)=>dot.classList.toggle('active',i===beat));
  };
  syncMenu();
})();
