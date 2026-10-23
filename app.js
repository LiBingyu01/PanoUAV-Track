/* PanoUAV-Track image-sequence 360° viewer. No MP4 decoding or video texture needed. */
(() => {
  'use strict';
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const modal=$('#panoModal'), stage=$('#panoModalStage');
  const gpu=$('#panoCanvas'), cpu=$('#panoCpuCanvas'), erp=$('#panoErpCanvas');
  if(!modal||!gpu||!cpu||!erp)return;
  const RAD=Math.PI/180, TAU=2*Math.PI, MAX_BOXES=12;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const formatted=t=>`${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`;
  const degrees=t=>`${String(((Math.round(t)%360)+360)%360).padStart(3,'0')}°`;
  let clip=null, annotations=null, bboxByFrame=new Map(), categoryEntry=null;
  let opened=false, playing=false, timeMs=0, lastTick=null, desired=0, shown=-1, image=null;
  let mode='immersive', yaw=0,pitch=0,fov=90, showGT=true, dragging=null;
  const dragHint=$('#panoDragHint');
  let dragHintTimer=null;
  function hideDragHint(){
    clearTimeout(dragHintTimer);
    dragHintTimer=null;
    dragHint?.classList.remove('is-visible');
  }
  function showDragHint(){
    hideDragHint();
    if(!opened || mode==='erp' || !dragHint)return;
    dragHint.classList.add('is-visible');
    dragHintTimer=setTimeout(hideDragHint,3000);
  }

  let raf=0, generation=0, sourceError='', prevFocus=null;
  let images=new Map(), loading=new Map(), renderer='webgl',lastGpuImage=null,lastCpuImage=null;
  let gl=null, shader=null, uniforms={}, texture=null, glInitialized=false, cpuStamp=0;
  // The forward camera uses the same original JPG, with no MP4 video texture.
  // ERP center longitude (u=0.5) is treated as the nominal camera-forward direction.
  const frontCanvas=$('#panoForwardCanvas');
  const frontCtx=frontCanvas?.getContext('2d',{alpha:false});
  const frontStatus=$('#panoForwardUnavailable');
  const frontSource=document.createElement('canvas');
  const frontSourceCtx=frontSource.getContext('2d',{willReadFrequently:true});
  const FRONT_HFOV=90, FRONT_ASPECT=16/9;
  let lastFrontImage=null,frontPixels=null,frontMap=null,frontMapKey='',frontOutput=null,frontFailed=false;
  function drawForwardInset(){
    if(!frontCtx || !image || mode!=='erp' || !opened || frontFailed)return;
    try{
      // Size of 320x180 is sufficient for a small inset, avoiding main-view FPS regressions.
      const w=320,h=180,sw=1024,sh=Math.round(sw*image.naturalHeight/image.naturalWidth);
      if(frontCanvas.width!==w||frontCanvas.height!==h){frontCanvas.width=w;frontCanvas.height=h;frontOutput=null;}
      if(frontSource.width!==sw || frontSource.height!==sh){frontSource.width=sw;frontSource.height=sh;lastFrontImage=null;}
      if(lastFrontImage!==image){
        frontSourceCtx.drawImage(image,0,0,sw,sh);
        frontPixels=frontSourceCtx.getImageData(0,0,sw,sh).data;
        lastFrontImage=image;
      }
      const key=`${w}/${h}/${sw}/${sh}`;
      if(frontMapKey!==key){
        // Precompute the 90° horizontal-FOV ray for every inset pixel once.
        frontMap=new Uint32Array(w*h);
        const tanHalf=Math.tan(FRONT_HFOV*RAD/2);
        for(let y=0;y<h;y++){
          const ny=(1-2*(y+0.5)/h)*tanHalf/FRONT_ASPECT;
          for(let x=0;x<w;x++){
            const nx=(2*(x+0.5)/w-1)*tanHalf;
            const len=Math.hypot(1,nx,ny);
            const lon=Math.atan2(nx,1),lat=Math.asin(clamp(ny/len,-1,1));
            const u=((lon/TAU+.5)%1+1)%1,v=clamp(.5-lat/Math.PI,0,1);
            const px=Math.min(sw-1,Math.floor(u*sw)),py=Math.min(sh-1,Math.floor(v*sh));
            frontMap[y*w+x]=(py*sw+px)*4;
          }
        }
        frontMapKey=key;
      }
      if(!frontOutput)frontOutput=frontCtx.createImageData(w,h);
      const out=frontOutput.data;
      for(let i=0;i<frontMap.length;i++){
        const from=frontMap[i],to=i*4;
        out[to]=frontPixels[from];out[to+1]=frontPixels[from+1];out[to+2]=frontPixels[from+2];out[to+3]=255;
      }
      frontCtx.putImageData(frontOutput,0,0);
      // Reproject GT boxes into the forward camera. Only visible targets within
      // the 90° viewport can appear; a hidden/out-of-view box is never fabricated.
      if(showGT && annotations && gtForImage().length){
        const bw=annotations.width||clip.width,bh=annotations.height||clip.height;
        frontCtx.strokeStyle='#bdff79';frontCtx.lineWidth=1;
        for(const box of gtForImage()){
          const left=box.x/bw,top=box.y/bh,right=(box.x+box.w)/bw,bottom=(box.y+box.h)/bh;
          // Sample box perimeter in spherical coordinates; supports non-linear projection.
          const pts=[];const N=14;
          for(let k=0;k<4*N;k++){
            const t=(k%N)/N;let u,v;
            if(k<N){u=left+(right-left)*t;v=top;}
            else if(k<2*N){u=right;v=top+(bottom-top)*t;}
            else if(k<3*N){u=right-(right-left)*t;v=bottom;}
            else {u=left;v=bottom-(bottom-top)*t;}
            const lon=(u-.5)*TAU,lat=(.5-v)*Math.PI;
            const X=Math.cos(lat)*Math.cos(lon),Y=Math.cos(lat)*Math.sin(lon),Z=Math.sin(lat);
            // Forward is +X. Points behind the front camera are not displayed.
            if(X<=0){pts.push(null);continue;}
            const nx=(Y/X)/Math.tan(FRONT_HFOV*RAD/2);
            const ny=(Z/X)*FRONT_ASPECT/Math.tan(FRONT_HFOV*RAD/2);
            pts.push({x:(nx+1)*w/2,y:(1-ny)*h/2});
          }
          frontCtx.beginPath();let pen=false;
          for(const pt of pts){
            if(!pt){pen=false;continue;}
            // Avoid drawing extraneous lines across the whole overlay at the seam.
            if(!Number.isFinite(pt.x)||!Number.isFinite(pt.y)||Math.abs(pt.x)>w*10||Math.abs(pt.y)>h*10){pen=false;continue;}
            if(!pen)frontCtx.moveTo(pt.x,pt.y);else frontCtx.lineTo(pt.x,pt.y);
            pen=true;
          }
          frontCtx.stroke();
        }
      }
      if(frontStatus)frontStatus.hidden=true;
    }catch(e){
      if(!frontFailed)console.warn('JPG forward-view inset unavailable:',e);
      frontFailed=true;
      if(frontStatus)frontStatus.hidden=false;
    }
  }
  const erpCtx=erp.getContext('2d',{alpha:false});
  const cpuCtx=cpu.getContext('2d',{alpha:false});
  const offscreen=document.createElement('canvas'), offctx=offscreen.getContext('2d',{willReadFrequently:true});
  let cpuOut=null;
  const isOffline = location.protocol === 'file:';
  // <script src> can load JS data from file:// without fetch or CORS permissions.
  const manifestPromise = isOffline
    ? (window.PANO_FRAMES_MANIFEST
        ? Promise.resolve(window.PANO_FRAMES_MANIFEST)
        : Promise.reject(Error('缺少离线帧索引 frames-manifest.js。请在站点目录运行一次 python build_offline_site.py，之后直接双击 index.html。')))
    : fetch('assets/gallery/frames-manifest.json',{cache:'no-store'}).then(r=>{
        if(!r.ok)throw Error(`frames-manifest.json HTTP ${r.status} — 请先运行 build_offline_site.py`);
        return r.json();
      }).catch(e=>window.PANO_FRAMES_MANIFEST || Promise.reject(e));
  manifestPromise.catch(()=>{}); // Opening a clip will display the precise error.
  const errBox=$('#panoError');
  function message(msg){sourceError=msg||'';errBox.hidden=!msg;errBox.textContent=msg||'';}
  function stageVisibility(){
    stage.classList.toggle('view-erp',mode==='erp');
    ['webgl','cpu','unavailable'].forEach(m=>stage.classList.toggle('renderer-'+m,renderer===m));
    stage.classList.add('frame-source');
  }
  function setCanvasSize(c,maxW=1600,maxH=1000){
    const rect=c.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.5);
    const w=Math.min(maxW,Math.max(1,Math.round(rect.width*dpr)));
    const h=Math.min(maxH,Math.max(1,Math.round(rect.height*dpr)));
    if(c.width!==w||c.height!==h){c.width=w;c.height=h;return true;}
    return false;
  }
  function boxesAt(frameIndex){return bboxByFrame.get(frameIndex+1)||[];}
  function gtForImage(){return showGT ? boxesAt(shown).slice(0,MAX_BOXES) : [];}
  function loadAnnotations(entry,gen){
    const gtReady = isOffline
      ? Promise.resolve(window.PANO_OFFLINE_ANNOTATIONS?.[entry.id] || null)
      : fetch(entry.annotation).then(r=>r.ok?r.json():Promise.reject(Error(`HTTP ${r.status}`)))
          .catch(()=>window.PANO_OFFLINE_ANNOTATIONS?.[entry.id] || null);
    gtReady.then(gt=>{
        if(!gt)throw Error('No bundled GT annotations for '+entry.id);
        if(gen!==generation)return;
        annotations=gt;
        bboxByFrame=new Map();
        (gt.boxes||[]).forEach(b=>{
          if(b.visible===false)return;
          const n=Number(b.frame);if(!bboxByFrame.has(n))bboxByFrame.set(n,[]);
          bboxByFrame.get(n).push(b);
        });
        const b=(bboxByFrame.get(1)||[])[0];
        if(b){yaw=(((b.x+b.w/2)/gt.width)-.5)*360;pitch=(.5-((b.y+b.h/2)/gt.height))*180;}
        $('#panoBoxes').disabled=!bboxByFrame.size;
        render(true);
      }).catch(e=>{
        if(gen!==generation)return;
        console.warn('GT unavailable:',e);
        annotations={width:entry.width,height:entry.height,boxes:[]};
        bboxByFrame=new Map();$('#panoBoxes').disabled=true;render(true);
      });
  }
  function frameUrl(index){
    const file=clip.files[index];
    return clip.base.split('/').map(encodeURIComponent).join('/')+encodeURIComponent(file);
  }
  function keepCache(){
    while(images.size>10){
      const key=images.keys().next().value;
      if(key===shown){ const val=images.get(key);images.delete(key);images.set(key,val);continue; }
      images.delete(key);
    }
  }
  // In file:// mode, local JPEG images may display but their pixels are tainted
  // in Chromium canvas/WebGL. A generated per-frame script contains a data: URL,
  // which gives the renderer an origin-clean image without a local HTTP server.
  function loadOfflinePayload(index){
    const file=clip.files[index];
    const key=`${clip.id}/${file}`;
    const path=`assets/gallery/offline-frames/${encodeURIComponent(clip.id)}/${encodeURIComponent(file)}.js`;
    return new Promise((resolve,reject)=>{
      const element=document.createElement('script');
      element.async=true;element.src=path;
      element.onload=()=>{
        element.remove();
        const src=window.PANO_FRAME_PAYLOAD?.[key];
        if(window.PANO_FRAME_PAYLOAD)delete window.PANO_FRAME_PAYLOAD[key];
        if(src?.startsWith('data:image/'))resolve(src);
        else reject(Error(`离线帧数据为空：${path}`));
      };
      element.onerror=()=>{element.remove();reject(Error(`缺少离线 JPG 包装：${path}。运行 python build_offline_site.py`));};
      document.head.appendChild(element);
    });
  }
  function requestFrame(index,gen,prefetch=false){
    if(!clip||gen!==generation||index<0||index>=clip.files.length)return;
    if(images.has(index)||loading.has(index)||loading.size>=5)return;
    const source=new Image();
    if(!isOffline) source.crossOrigin='anonymous';
    source.decoding='async';
    loading.set(index,source);
    source.onload=()=>{
      if(gen!==generation)return;
      loading.delete(index);
      images.set(index,source);keepCache();
      if(index===desired){shown=index;image=source;render(true);syncControls();}
      if(!prefetch)prefetchNearby(gen);
    };
    source.onerror=()=>{
      if(gen!==generation)return;
      loading.delete(index);
      if(index===desired)message(`无法读取 JPG 帧：${clip.files[index]}。检查 offline-frames 文件，或重新运行 build_offline_site.py。`);
    };
    if(isOffline){
      loadOfflinePayload(index).then(src=>{if(gen===generation)source.src=src;else loading.delete(index);})
        .catch(e=>{loading.delete(index);if(gen===generation&&index===desired)message(e.message);});
    }else source.src=frameUrl(index);
  }
  function prefetchNearby(gen){
    if(!clip)return;
    for(let i=1;i<=3;i++)requestFrame((desired+i)%clip.files.length,gen,true);
  }
  function useFrame(index){
    if(!clip)return;
    index=clamp(index,0,clip.files.length-1);
    desired=index;
    if(images.has(index)){
      // Refresh insertion order for eviction.
      image=images.get(index);images.delete(index);images.set(index,image);
      shown=index;render();
    } else requestFrame(index,generation);
    prefetchNearby(generation);
  }
  function setMode(next){
    if(!['immersive','globe','erp'].includes(next))return;
    mode=next;
    $$('.pano-mode').forEach(b=>{
      const active=b.dataset.view===next;
      b.classList.toggle('is-active',active);
      b.setAttribute('aria-pressed',String(active));
    });
    if(mode!=='erp'&&renderer==='unavailable'){renderer='cpu';message('');}
    stageVisibility();render(true);showDragHint();
  }
  function drawERP(){
    if(!image||!erpCtx)return;
    setCanvasSize(erp,1920,1080);
    const w=erp.width,h=erp.height,iw=image.naturalWidth,ih=image.naturalHeight;
    const scale=Math.min(w/iw,h/ih),rw=iw*scale,rh=ih*scale;
    const ox=(w-rw)/2,oy=(h-rh)/2;
    erpCtx.fillStyle='#061018';erpCtx.fillRect(0,0,w,h);
    erpCtx.drawImage(image,ox,oy,rw,rh);
    const bw=annotations?.width||clip.width,bh=annotations?.height||clip.height;
    const sx=rw/bw,sy=rh/bh;
    erpCtx.font='12px monospace';erpCtx.lineWidth=2;
    gtForImage().forEach(b=>{
      const x=ox+b.x*sx,y=oy+b.y*sy,w=b.w*sx,hh=b.h*sy;
      erpCtx.strokeStyle='#bdff79';erpCtx.fillStyle='#bdff79';
      const split=Math.min(w,ox+rw-x);
      if(split>0)erpCtx.strokeRect(x,y,split,hh);
      if(x+w>ox+rw)erpCtx.strokeRect(ox,y,x+w-(ox+rw),hh);
      erpCtx.fillText(`GT ${b.track}`,Math.max(ox,x),Math.max(oy+12,y-4));
    });
    drawForwardInset();
  }
  function compile(type,src){
    const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));
    return s;
  }
  function setupWebGL(){
    glInitialized=true;
    try{
      gl=gpu.getContext('webgl',{alpha:false,antialias:false,powerPreference:'high-performance'});
      if(!gl)throw Error('No WebGL context');
      const vertex=`attribute vec2 position; varying vec2 uv; void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
      const fragment=`precision highp float;
        varying vec2 uv; uniform sampler2D tex;
        uniform float yaw,pitch,tanFov,ratio,projection,showGT,boxCount;
        uniform vec4 boxes[${MAX_BOXES}]; const float PI=3.141592653589793;
        void main(){
          vec2 s=uv*2.0-1.0;
          vec3 forward=vec3(cos(pitch)*cos(yaw),cos(pitch)*sin(yaw),sin(pitch));
          vec3 right=vec3(-sin(yaw),cos(yaw),0.0);
          vec3 up=vec3(-sin(pitch)*cos(yaw),-sin(pitch)*sin(yaw),cos(pitch));
          vec3 ray;float shade=1.0;
          if(projection<0.5){ray=normalize(forward+s.x*ratio*tanFov*right+s.y*tanFov*up);}
          else{
            vec2 p=s*vec2(ratio,1.0)*0.85;
            float r2=dot(p,p);
            if(r2>1.0){gl_FragColor=vec4(0.02,0.035,0.05,1.0);return;}
            float depth=sqrt(1.0-r2);
            ray=normalize(p.x*right+p.y*up+depth*forward);
            shade=0.75+0.25*depth;
          }
          float longitude=atan(ray.y,ray.x),latitude=asin(clamp(ray.z,-1.0,1.0));
          vec2 st=vec2(fract(longitude/(2.0*PI)+0.5),0.5-latitude/PI);
          vec3 color=texture2D(tex,st).rgb*shade;
          if(showGT>0.5){
            for(int i=0;i<${MAX_BOXES};i++){
              if(float(i)>=boxCount)break;
              vec4 b=boxes[i];float dx=fract(st.x-b.x+1.0);float line=0.0007;
              bool insideX=dx<=b.z,insideY=st.y>=b.y&&st.y<=b.w;
              bool ex=(dx<line||abs(dx-b.z)<line)&&insideY;
              bool ey=(abs(st.y-b.y)<line||abs(st.y-b.w)<line)&&insideX;
              if(ex||ey)color=vec3(0.73,1.0,0.44);
            }
          }
          gl_FragColor=vec4(color,1.0);
        }`;
      shader=gl.createProgram();gl.attachShader(shader,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(shader,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(shader);
      if(!gl.getProgramParameter(shader,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(shader));
      gl.useProgram(shader);
      const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
      const loc=gl.getAttribLocation(shader,'position');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
      for(const name of ['tex','yaw','pitch','tanFov','ratio','projection','showGT','boxCount','boxes'])
        uniforms[name]=gl.getUniformLocation(shader,name==='boxes'?'boxes[0]':name);
      texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
      for(const filter of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,filter,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.uniform1i(uniforms.tex,0);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
      renderer='webgl';
    }catch(e){renderer='cpu';console.warn('WebGL unavailable — using JPEG CPU projection',e);}
    stageVisibility();
  }
  function drawGPU(){
    setCanvasSize(gpu,1600,1000);
    gl.viewport(0,0,gpu.width,gpu.height);gl.useProgram(shader);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
    if(lastGpuImage!==image){
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
      const error=gl.getError();if(error!==gl.NO_ERROR)throw Error(`JPEG texture upload GL error ${error}`);
      lastGpuImage=image;
    }
    gl.uniform1f(uniforms.yaw,yaw*RAD);gl.uniform1f(uniforms.pitch,pitch*RAD);
    gl.uniform1f(uniforms.tanFov,Math.tan(fov*RAD/2));gl.uniform1f(uniforms.ratio,gpu.width/gpu.height);
    gl.uniform1f(uniforms.projection,mode==='immersive'?0:1);
    gl.uniform1f(uniforms.showGT,showGT?1:0);
    const bb=gtForImage(),bw=annotations?.width||clip.width,bh=annotations?.height||clip.height;
    const data=new Float32Array(MAX_BOXES*4);
    bb.forEach((b,i)=>data.set([b.x/bw,b.y/bh,b.w/bw,(b.y+b.h)/bh],i*4));
    gl.uniform4fv(uniforms.boxes,data);gl.uniform1f(uniforms.boxCount,bb.length);
    gl.drawArrays(gl.TRIANGLES,0,6);
    const code=gl.getError();if(code!==gl.NO_ERROR)throw Error(`WebGL draw GL error ${code}`);
  }
  function drawCPU(){
    if(!offctx||!cpuCtx)throw Error('Canvas2D unavailable');
    const srcWidth=Math.min(image.naturalWidth,1024),srcHeight=Math.round(srcWidth*image.naturalHeight/image.naturalWidth);
    if(offscreen.width!==srcWidth||offscreen.height!==srcHeight){offscreen.width=srcWidth;offscreen.height=srcHeight;}
    if(lastCpuImage!==image){offctx.drawImage(image,0,0,srcWidth,srcHeight);lastCpuImage=image;}
    const src=offctx.getImageData(0,0,srcWidth,srcHeight),pixels=src.data;
    const rect=stage.getBoundingClientRect(),width=Math.min(560,Math.max(1,Math.floor(rect.width)));
    const height=Math.max(1,Math.round(width*rect.height/Math.max(1,rect.width)));
    if(cpu.width!==width||cpu.height!==height){cpu.width=width;cpu.height=height;cpuOut=null;}
    if(!cpuOut)cpuOut=cpuCtx.createImageData(width,height);
    const out=cpuOut.data,ratio=rect.width/Math.max(1,rect.height),f=Math.tan(fov*RAD/2);
    const yy=yaw*RAD,pp=pitch*RAD,cy=Math.cos(yy),sy=Math.sin(yy),cp=Math.cos(pp),sp=Math.sin(pp);
    const f0=cp*cy,f1=cp*sy,f2=sp,r0=-sy,r1=cy,u0=-sp*cy,u1=-sp*sy,u2=cp;
    const boxes=gtForImage(),bw=annotations?.width||clip.width,bh=annotations?.height||clip.height;
    for(let y=0;y<height;y++){
      const vy=1-2*(y+0.5)/height;
      for(let x=0;x<width;x++){
        const vx=2*(x+0.5)/width-1;let a,b,z,x0,y0,z0,shade=1;
        if(mode==='globe'){
          a=vx*ratio*.85;b=vy*.85;const r2=a*a+b*b;
          if(r2>1){const d=4*(y*width+x);out[d]=6;out[d+1]=10;out[d+2]=15;out[d+3]=255;continue;}
          z=Math.sqrt(1-r2);shade=.75+.25*z;
          x0=f0*z+r0*a+u0*b;y0=f1*z+r1*a+u1*b;z0=f2*z+u2*b;
        }else{
          a=vx*ratio*f;b=vy*f;
          x0=f0+r0*a+u0*b;y0=f1+r1*a+u1*b;z0=f2+u2*b;
        }
        const length=Math.hypot(x0,y0,z0),longitude=Math.atan2(y0,x0),latitude=Math.asin(clamp(z0/length,-1,1));
        const uu=((longitude/TAU+.5)%1+1)%1,vv=clamp(.5-latitude/Math.PI,0,1);
        const px=Math.min(srcWidth-1,Math.floor(uu*srcWidth)),py=Math.min(srcHeight-1,Math.floor(vv*srcHeight));
        const srcIndex=(py*srcWidth+px)*4,dst=(y*width+x)*4;
        out[dst]=pixels[srcIndex]*shade;out[dst+1]=pixels[srcIndex+1]*shade;out[dst+2]=pixels[srcIndex+2]*shade;out[dst+3]=255;
        for(let i=0;i<boxes.length;i++){
          const box=boxes[i],bx=box.x/bw,by=box.y/bh,bww=box.w/bw,by2=(box.y+box.h)/bh;
          const dx=(uu-bx+1)%1,line=.0009;
          if(dx<=bww&&vv>=by&&vv<=by2&&((dx<line||Math.abs(dx-bww)<line)||(Math.abs(vv-by)<line||Math.abs(vv-by2)<line))){
            out[dst]=180;out[dst+1]=255;out[dst+2]=112;break;
          }
        }
      }
    }
    cpuCtx.putImageData(cpuOut,0,0);
  }
  function render(force=false){
    if(!opened||!image||shown<0)return;
    try{
      if(mode==='erp')drawERP();
      else{
        if(!glInitialized)setupWebGL();
        if(renderer==='webgl'){
          try{drawGPU();}
          catch(e){console.warn('JPEG WebGL failed; Canvas2D fallback:',e);renderer='cpu';drawCPU();}
        }else{
          if(!force&&performance.now()-cpuStamp<130)return;
          cpuStamp=performance.now();drawCPU();
        }
      }
      stageVisibility();message('');
    }catch(e){
      console.error('JPG spherical viewer failed:',e);
      renderer='unavailable';stageVisibility();
      message(`无法读取 JPG 像素：${e.message}。请检查离线 JPG 帧包装文件。若尚未生成，请运行一次 build_offline_site.py。`);
    }
  }
  function syncControls(){
    $('#panoYaw').textContent=`AZ ${degrees(yaw)}`;
    $('#panoPitch').textContent=`EL ${pitch>=0?'+':''}${Math.round(pitch)}°`;
    $('#panoFov').textContent=`FOV ${Math.round(fov)}°`;
    $('#panoPlay').textContent=playing?'Ⅱ':'▶';
    const fps=clip?.fps||10,total=clip?.files.length||0;
    $('#panoTime').textContent=`${formatted(timeMs/1000)} / ${formatted(total/fps)}`;
    if(!$('#panoSeek').matches(':active')&&total>0)$('#panoSeek').value=String(Math.round(timeMs/(total/fps*1000)*1000));
    $('#panoFrame').textContent=`FRAME ${String(shown+1).padStart(3,'0')} / ${String(total||0).padStart(3,'0')} · JPG`;
  }
  function tick(stamp){
    if(!opened)return;
    const elapsed=lastTick===null?0:clamp(stamp-lastTick,0,180);lastTick=stamp;
    if(playing&&clip?.files.length){
      const duration=clip.files.length/clip.fps*1000;
      timeMs=(timeMs+elapsed)%duration;
      const next=Math.min(clip.files.length-1,Math.floor(timeMs/1000*clip.fps));
      if(next!==desired)useFrame(next);
      syncControls();
    }
    raf=requestAnimationFrame(tick);
  }
  async function open(entry){
    if(!entry)return;
    prevFocus=document.activeElement;
    const gen=++generation;
    categoryEntry=entry;clip=null;annotations=null;bboxByFrame=new Map();
    desired=shown=-1;image=null;images.clear();loading.clear();
    lastGpuImage=lastCpuImage=null;lastFrontImage=null;frontPixels=null;frontFailed=false;timeMs=0;lastTick=null;playing=false;
    yaw=0;pitch=0;fov=90;showGT=true;renderer=glInitialized && !gl?'cpu':'webgl';
    $('#panoBoxes').disabled=true;$('#panoBoxes').setAttribute('aria-pressed','true');
    $('#panoModalTitle').textContent=entry.name;
    $('#panoModalDomain').textContent=({light:'DAYLIGHT',night:'NIGHTTIME',simulation:'SIMULATION'})[entry.category]||'ERP';
    $('#panoModalSub').textContent='JPG frames · 360° spherical viewer · drag to rotate';
    modal.setAttribute('aria-hidden','false');document.body.classList.add('pano-modal-open');
    opened=true;setMode('immersive');message('正在读取 JPG 帧索引…');
    stageVisibility();window.dispatchEvent(new Event('pano:open'));
    $('#panoClose').focus();cancelAnimationFrame(raf);raf=requestAnimationFrame(tick);
    try{
      const manifest=await manifestPromise;
      if(!opened||gen!==generation)return;
      const match=manifest.sequences?.[entry.id];
      if(!match||!Array.isArray(match.files)||!match.files.length)
        throw Error(`索引中没有 ${entry.id}。请确认此序列在 assets/gallery/demo/sequences/，然后运行 python build_offline_site.py`);
      clip=match;
      loadAnnotations(match,gen);
      playing=true;useFrame(0);syncControls();
    }catch(e){
      if(gen!==generation)return;
      playing=false;message(`无法载入图片序列：${e.message}`);console.error('Pano frame viewer:',e);
    }
  }
  function close(){
    if(!opened)return;
    hideDragHint();
    generation++;opened=false;playing=false;clip=null;images.clear();loading.clear();image=null;shown=-1;
    cancelAnimationFrame(raf);modal.setAttribute('aria-hidden','true');document.body.classList.remove('pano-modal-open');
    message('');window.dispatchEvent(new Event('pano:close'));
    prevFocus?.focus?.();
  }
  function seek(value){
    if(!clip)return;
    const duration=clip.files.length/clip.fps*1000;
    timeMs=clamp(Number(value)/1000*duration,0,duration-1000/clip.fps);
    lastTick=null;useFrame(Math.min(clip.files.length-1,Math.floor(timeMs/1000*clip.fps)));
    syncControls();
  }
  window.Pano360={open,close,debug:()=>({renderer,mode,frameSource:'jpg',clip:clip?.name,shownFrame:shown+1,desiredFrame:desired+1,cache:images.size,waiting:loading.size,error:sourceError,origin:location.origin,isOffline})};
  $('#panoForwardInset')?.addEventListener('click',()=>{
    if(!opened || mode!=='erp')return;
    // The main Immersive viewer uses vertical FOV; convert our inset's
    // 90-degree horizontal FOV to its equivalent vertical FOV at 16:9.
    yaw=0;pitch=0;
    fov=2*Math.atan(Math.tan(FRONT_HFOV*RAD/2)/FRONT_ASPECT)/RAD;
    setMode('immersive');syncControls();
  });
  $('#panoClose').addEventListener('click',close);
  modal.addEventListener('pointerdown',e=>{if(e.target===modal)close();});
  $('#panoPlay').addEventListener('click',()=>{if(!clip)return;playing=!playing;lastTick=null;syncControls();});
  $('#panoSeek').addEventListener('input',e=>seek(e.target.value));
  $('#panoBoxes').addEventListener('click',e=>{showGT=!showGT;e.currentTarget.setAttribute('aria-pressed',String(showGT));render(true);});
  $('#panoReset').addEventListener('click',()=>{yaw=0;pitch=0;fov=90;render(true);syncControls();});
  $$('.pano-mode').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.view)));
  $('#panoFullScreen').addEventListener('click',()=>{
    const shell=$('.pano-modal-shell',modal);
    if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
    else shell.requestFullscreen?.().catch(()=>{});
  });
  for(const surface of [gpu,cpu,erp]){
    surface.addEventListener('pointerdown',e=>{if(mode==='erp')return;hideDragHint();dragging={x:e.clientX,y:e.clientY,yaw,pitch};surface.setPointerCapture(e.pointerId);});
    surface.addEventListener('pointermove',e=>{
      if(!dragging||mode==='erp')return;
      const factor=fov/Math.max(1,surface.clientWidth);
      yaw=dragging.yaw-(e.clientX-dragging.x)*factor;
      pitch=clamp(dragging.pitch+(e.clientY-dragging.y)*factor,-88,88);
      render(true);syncControls();
    });
    surface.addEventListener('pointerup',()=>dragging=null);
    surface.addEventListener('pointercancel',()=>dragging=null);
  }
  stage.addEventListener('wheel',e=>{if(mode==='erp')return;hideDragHint();e.preventDefault();fov=clamp(fov+e.deltaY*.04,45,120);render(true);syncControls();},{passive:false});
  document.addEventListener('keydown',e=>{
    if(!opened)return;
    if(e.key==='Escape'){close();return;}
    if(e.code==='Space'&&!['BUTTON','INPUT'].includes(document.activeElement?.tagName)){
      e.preventDefault();playing=!playing;lastTick=null;syncControls();
    }
    if(e.key==='ArrowLeft'&&document.activeElement?.tagName!=='INPUT'){yaw-=6;render(true);syncControls();}
    if(e.key==='ArrowRight'&&document.activeElement?.tagName!=='INPUT'){yaw+=6;render(true);syncControls();}
  });
  window.addEventListener('resize',()=>render(true));
  gpu.addEventListener('webglcontextlost',e=>{e.preventDefault();gl=null;renderer='cpu';lastCpuImage=null;stageVisibility();render(true);});
  gpu.addEventListener('webglcontextrestored',()=>{glInitialized=false;gl=null;lastGpuImage=null;renderer='webgl';render(true);});
})();
