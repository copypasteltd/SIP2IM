class CaptureProcessor extends AudioWorkletProcessor {
 private filtered=0; private phase=0; private previous=0; private frame:number[]=[];
 process(inputs:Float32Array[][]):boolean {const samples=inputs[0]?.[0];if(!samples)return true;const alpha=Math.min(1,2*Math.PI*7000/sampleRate);for(const sample of samples){this.filtered+=alpha*(sample-this.filtered);this.phase+=16000;while(this.phase>=sampleRate){this.phase-=sampleRate;const fraction=1-this.phase/16000;this.frame.push(this.previous+(this.filtered-this.previous)*Math.max(0,Math.min(1,fraction)));if(this.frame.length===320){this.port.postMessage(new Float32Array(this.frame));this.frame=[];}}this.previous=this.filtered;}return true;}
}
registerProcessor('voip-capture',CaptureProcessor);
