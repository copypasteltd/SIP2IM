class PlaybackProcessor extends AudioWorkletProcessor {
 private queue:Float32Array[]=[];private current:Float32Array|null=null;private position=0;private started=false;
 constructor(){super();this.port.onmessage=(event:MessageEvent<unknown>)=>{if(event.data instanceof Float32Array&&event.data.length===320){this.queue.push(event.data);while(this.queue.length>15)this.queue.shift();}};}
 process(_inputs:Float32Array[][],outputs:Float32Array[][]):boolean {const out=outputs[0]?.[0];if(!out)return true;if(!this.started){if(this.queue.length<4){out.fill(0);return true;}this.started=true;}for(let i=0;i<out.length;i++){if(!this.current){this.current=this.queue.shift()??null;this.position=0;}if(!this.current){out[i]=0;continue;}const index=Math.floor(this.position);const fraction=this.position-index;const next=this.current[index+1]??this.queue[0]?.[0]??this.current[index];out[i]=this.current[index]+(next-this.current[index])*fraction;this.position+=16000/sampleRate;if(this.position>=320){this.position-=320;this.current=this.queue.shift()??null;}}return true;}
}
registerProcessor('voip-playback',PlaybackProcessor);
