const saved=localStorage.getItem('voip.theme');
document.documentElement.dataset.theme=saved==='dark'||saved==='light'?saved:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
