/* DigitalWaves — dependency-free, two-pass WebGL character water.
 * Coordinates supplied to drop() are CSS pixels relative to the canvas.
 * A visual reconstruction from a reference clip, not Claude's original code.
 */
(function (global) {
  'use strict';
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const SEQUENCE = [[1.18,.087,.765,1],[2.36,.887,.125,1],[3.60,.725,.75,1],[5.12,.085,.195,.42]];
  const VERT = `attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}`;
  const NOISE = `
    float hash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
    float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    float fbm(vec2 p){return .57*noise(p)+.28*noise(p*2.03+7.1)+.15*noise(p*4.07+21.3);}
  `;
  const FIELD = `precision highp float;
    uniform vec2 size, cell; uniform float time, scale, seed, flowOffset;
    uniform vec4 drops[24]; uniform int count;
    ${NOISE}
    void main(){
      vec2 p=(floor(gl_FragCoord.xy)+.5)*cell;
      float flow=time*.035+flowOffset;
      for(int i=0;i<24;i++){if(i<count){float a=time-drops[i].z; if(a>0.){
        flow+=.36*(1.-exp(-min(a,4.)*1.4));
      }}}
      vec2 q=p/max(scale,.4);
      vec2 drift=vec2(flow*.37,-flow*.27)+seed;
      vec2 warp=vec2(fbm(q*.005+drift),fbm(q*.005+drift+25.));
      float water=fbm(q*.014+warp*3.2+drift);
      float fine=noise(q*.039+warp*2.+drift*1.6);
      float calm=fbm(q*.008+vec2(time*.012,-time*.009)+seed);
      float gray=pow(smoothstep(.48,.74,calm),1.7)*.47;
      float blue=0.; float wake=0.;
      for(int i=0;i<24;i++){
        if(i<count){float age=time-drops[i].z;
          if(age>0. && age<3.4){
            vec2 delta=(p-drops[i].xy)/max(scale,.4);
            float distance=length(delta);
            float radius=470.*pow(age,.78);
            // Broad refraction bends the front; finer noise tears its edge.
            float bend=fbm(q*.007+vec2(float(i)*13.)+drift*.55)-.5;
            float wrinkle=noise(q*.027+warp*2.7+drift)-.5;
            float distortion=bend*(80.+min(age,2.)*110.)+wrinkle*22.;
            float edge=distance+distortion-radius;
            float width=10.+age*12.;
            float ring=exp(-pow(edge/width,2.));
            float breakup=smoothstep(.29+age*.09,.56+age*.07,water+fine*.16);
            float fade=1.-smoothstep(.65,2.25,age);
            float crest=ring*breakup*fade;
            float inside=(1.-smoothstep(-45.,20.,edge));
            float localAge=max(0.,age-pow(max(distance,1.)/480.,1./.78));
            float tail=inside*exp(-localAge*1.6)*(1.-smoothstep(1.3,3.1,age));
            float eddies=pow(smoothstep(.43,.69,water*.85+fine*.22),1.5);
            float filaments=exp(-abs(water-.51)*20.);
            eddies=mix(eddies,filaments*.55,.35);
            float onset=mix(.38,1.,smoothstep(.28,.65,age));
            blue+=(crest*.52+tail*eddies*.62)*drops[i].w*onset;
            float grayTail=inside*exp(-localAge*.85)*(1.-smoothstep(1.8,3.4,age));
            wake+=grayTail*(.05+.80*pow(smoothstep(.40,.70,water),1.5));
          }
        }
      }
      gray+=wake;
      blue=.62*pow(clamp(blue*1.6,0.,1.),.65);
      float grain=.67+.33*hash(floor(p/cell)+31.);
      gray*=grain; blue*=grain;
      gl_FragColor=vec4(clamp(gray,0.,1.),blue,0.,1.);
    }`;
  const DRAW = `precision highp float;
    uniform sampler2D field,atlas; uniform vec2 resolution,size,grid,cell,atlasTile;
    uniform float time,seed;
    ${NOISE}
    void main(){
      vec2 p=vec2(gl_FragCoord.x,resolution.y-gl_FragCoord.y)*size/resolution;
      vec2 id=floor(p/cell), within=fract(p/cell);
      vec2 light=texture2D(field,(id+.5)/grid).rg;
      float rate=mix(1.,5.,step(.12,light.y+light.x));
      float tick=floor(time*rate+hash(id)*13.);
      float glyph=floor(hash(id+vec2(tick*7.13,seed+tick*.17))*62.);
      vec2 tile=vec2(mod(glyph,16.),floor(glyph/16.));
      vec2 uv=(tile+within)/vec2(16.,4.);
      float ink=texture2D(atlas,uv).a;
      vec3 background=vec3(23./255.);
      vec3 color=background+vec3(.19)*light.x;
      color=mix(color,vec3(.15,.50,.73),light.y);
      gl_FragColor=vec4(mix(background,color,ink),1.);
    }`;

  function create(canvas, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('DigitalWaves.create requires a canvas.');
    const gl=canvas.getContext('webgl',{alpha:false,antialias:false,powerPreference:'low-power',preserveDrawingBuffer:false});
    if(!gl) throw new Error('WebGL is unavailable. Enable hardware acceleration to display the water.');
    let mode=options.mode||'sequence', disposed=false, lost=false;
    let time=Number.isFinite(options.time)?options.time:0, paused=!!options.paused;
    let last=performance.now(), raf=0, width=1,height=1,cols=1,rows=1,dpr=1,nextDrip=0;
    let manual=[], resources, atlasCanvas, flowOffset=0;
    const cell=[options.cellWidth||8.5,options.cellHeight||17];
    const seed=options.seed??7, programs=[];
    const locations=new Map();
    function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const e=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(e);}return s;}
    function program(source){const p=gl.createProgram(),v=shader(gl.VERTEX_SHADER,VERT),f=shader(gl.FRAGMENT_SHADER,source);gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);gl.deleteShader(v);gl.deleteShader(f);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));programs.push(p);return p;}
    function loc(p,name){let m=locations.get(p);if(!m){m={};locations.set(p,m);}return m[name]??(m[name]=gl.getUniformLocation(p,name));}
    function texture(){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t;}
    function buildAtlas(){
      const atlasRatio=Math.max(2,dpr);
      const tw=Math.ceil(cell[0]*atlasRatio),th=Math.ceil(cell[1]*atlasRatio);
      atlasCanvas=document.createElement('canvas');atlasCanvas.width=tw*16;atlasCanvas.height=th*4;
      const ctx=atlasCanvas.getContext('2d');ctx.fillStyle='white';ctx.textAlign='center';ctx.textBaseline='alphabetic';
      ctx.font=`${(options.fontSize||12.5)*atlasRatio}px ${options.fontFamily||'Digital Mono, ui-monospace, Menlo, Consolas, monospace'}`;
      for(let i=0;i<CHARS.length;i++)ctx.fillText(CHARS[i],(i%16+.5)*tw,Math.floor(i/16)*th+th*.63);
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,resources.atlas);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,atlasCanvas);
    }
    function init(){
      programs.length=0;locations.clear();
      const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
      resources={field:program(FIELD),draw:program(DRAW),buffer,texture:texture(),atlas:texture(),framebuffer:gl.createFramebuffer()};
      resize(true);
    }
    function resize(force=false){
      const rect=canvas.getBoundingClientRect(),w=Math.max(1,rect.width),h=Math.max(1,rect.height),ratio=Math.min(options.maxPixelRatio||2,window.devicePixelRatio||1);
      if(!force&&w===width&&h===height&&dpr===ratio)return;
      width=w;height=h;dpr=ratio;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
      cols=Math.ceil(w/cell[0]);rows=Math.ceil(h/cell[1]);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,resources.texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,cols,rows,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,resources.framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,resources.texture,0);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Unable to allocate the wave field.');
      buildAtlas();
    }
    function use(p){gl.useProgram(p);gl.bindBuffer(gl.ARRAY_BUFFER,resources.buffer);const at=gl.getAttribLocation(p,'position');gl.enableVertexAttribArray(at);gl.vertexAttribPointer(at,2,gl.FLOAT,false,0,0);}
    function draw(){
      if(disposed||lost)return;
      resize();
      const t=mode==='sequence'?((time%10)+10)%10:time;
      const active=mode==='sequence'?SEQUENCE.filter(d=>d[0]<=t).map(d=>[d[1]*width,d[2]*height,d[0],d[3]]):[];
      manual=manual.filter(d=>{if(time-d[2]<3.4)return true;flowOffset+=.36;return false;});
      for(const d of manual)active.push([d[0]*width,d[1]*height,t-(time-d[2]),d[3]]);
      const data=new Float32Array(24*4);active.slice(-24).forEach((d,i)=>data.set(d,i*4));
      const p=resources.field;use(p);gl.bindFramebuffer(gl.FRAMEBUFFER,resources.framebuffer);gl.viewport(0,0,cols,rows);
      gl.uniform2f(loc(p,'size'),width,height);gl.uniform2f(loc(p,'cell'),...cell);gl.uniform1f(loc(p,'time'),t);gl.uniform1f(loc(p,'seed'),seed);gl.uniform1f(loc(p,'flowOffset'),flowOffset);gl.uniform1f(loc(p,'scale'),options.scale||Math.min(width/866,height/734));gl.uniform1i(loc(p,'count'),Math.min(24,active.length));gl.uniform4fv(loc(p,'drops[0]'),data);gl.drawArrays(gl.TRIANGLES,0,6);
      const q=resources.draw;use(q);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,canvas.width,canvas.height);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,resources.texture);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,resources.atlas);
      gl.uniform1i(loc(q,'field'),0);gl.uniform1i(loc(q,'atlas'),1);gl.uniform2f(loc(q,'resolution'),canvas.width,canvas.height);gl.uniform2f(loc(q,'size'),width,height);gl.uniform2f(loc(q,'grid'),cols,rows);gl.uniform2f(loc(q,'cell'),...cell);gl.uniform1f(loc(q,'time'),t);gl.uniform1f(loc(q,'seed'),seed);gl.drawArrays(gl.TRIANGLES,0,6);
    }
    function loop(now){
      if(disposed)return;
      const dt=Math.min((now-last)/1000,.1);last=now;
      if(!paused&&!document.hidden&&!lost){time+=dt;if(mode==='random'&&time>=nextDrip){drop(width*(.08+Math.random()*.84),height*(.08+Math.random()*.84));nextDrip=time+1.1+Math.random()*2.4;}draw();}
      raf=requestAnimationFrame(loop);
    }
    function drop(x,y,strength=1){if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(strength))return;manual.push([x/width,y/height,time-.016,Math.max(0,Math.min(2,strength))]);if(manual.length>24){const old=manual.shift();flowOffset+=.36*(1.-Math.exp(-Math.max(0,time-old[2])*1.4));}if(paused)draw();}
    function seek(t){if(!Number.isFinite(t))return;time=Math.max(0,t);manual=[];flowOffset=0;nextDrip=time;last=performance.now();draw();}
    function pointer(e){if(options.interactive===false)return;const r=canvas.getBoundingClientRect();drop(e.clientX-r.left,e.clientY-r.top);}
    function onLost(e){e.preventDefault();lost=true;}
    function onRestored(){lost=false;init();draw();}
    const observer=new ResizeObserver(()=>{if(!lost&&!disposed)draw();});
    init();draw();observer.observe(canvas);canvas.addEventListener('pointerdown',pointer);canvas.addEventListener('webglcontextlost',onLost);canvas.addEventListener('webglcontextrestored',onRestored);raf=requestAnimationFrame(loop);
    return {
      drop,seek,render:draw,
      capture(){draw();return canvas.toDataURL('image/png');},
      pause(){paused=true;},play(){paused=false;last=performance.now();},
      setMode(value){if(!['sequence','random','manual'].includes(value))throw new Error('Unknown wave mode');mode=value;seek(0);},
      get time(){return mode==='sequence'?time%10:time;},get paused(){return paused;},get mode(){return mode;},
      destroy(){disposed=true;cancelAnimationFrame(raf);observer.disconnect();canvas.removeEventListener('pointerdown',pointer);canvas.removeEventListener('webglcontextlost',onLost);canvas.removeEventListener('webglcontextrestored',onRestored);programs.forEach(p=>gl.deleteProgram(p));gl.deleteTexture(resources.texture);gl.deleteTexture(resources.atlas);gl.deleteFramebuffer(resources.framebuffer);gl.deleteBuffer(resources.buffer);}
    };
  }
  global.DigitalWaves=Object.freeze({create});
})(window);
