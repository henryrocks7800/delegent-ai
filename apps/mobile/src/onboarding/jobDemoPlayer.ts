// This exact HTML runs in the existing Android/iOS WebView. Keep it separate
// so browser playback events and Replay can be exercised without a Store build.
export function jobDemoHtml(videoBase64: string, posterBase64: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f7f6f1"><video id="demo" aria-label="Real Delegent AI demonstration, no audio" autoplay muted playsinline controls poster="data:image/jpeg;base64,${posterBase64}" onplaying="window.ReactNativeWebView.postMessage('playing')" onended="window.ReactNativeWebView.postMessage('ended')" onerror="window.ReactNativeWebView.postMessage('failed')" style="display:block;width:100%;height:100vh;object-fit:contain" src="data:video/mp4;base64,${videoBase64}"></video></body></html>`;
}

// A tap starts a fresh play. Completion never seeks or plays automatically.
export const REPLAY_DEMO_SCRIPT = `
(function () {
  var video = document.getElementById('demo');
  if (!video) return;
  video.currentTime = 0;
  var play = video.play();
  if (play && play.catch) play.catch(function () {
    window.ReactNativeWebView.postMessage('failed');
  });
})(); true;
`;
