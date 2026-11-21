export function microphoneAvailable():boolean {return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia==='function' && typeof AudioWorkletNode!=='undefined';}
