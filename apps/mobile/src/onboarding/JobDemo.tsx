import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { WebView } from 'react-native-webview';
import { Button, Text } from '../design/primitives';
import { DEMO_FINISH, type OnboardingGoal } from './growthContent';
import { jobDemoHtml, REPLAY_DEMO_SCRIPT } from './jobDemoPlayer';
import { useIsAgentEngine } from '../state/coworkerEngine';

const media = {
  receipts: { video: require('../../assets/onboarding/receipts.mp4'), poster: require('../../assets/onboarding/receipts.jpg') },
  inbox: { video: require('../../assets/onboarding/email.mp4'), poster: require('../../assets/onboarding/email.jpg') },
  admin: { video: require('../../assets/onboarding/email.mp4'), poster: require('../../assets/onboarding/email.jpg') },
  something_else: { video: require('../../assets/onboarding/connections.mp4'), poster: require('../../assets/onboarding/connections.jpg') },
};

// Uses native modules already present in both production binaries. expo-av
// is deliberately excluded from iOS and cannot be introduced by an OTA.
export function JobDemo({ goal }: { goal: OnboardingGoal }) {
  const agentEngine = useIsAgentEngine();
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [ended, setEnded] = useState(false);
  const webView = useRef<WebView>(null);
  const source = useMemo(() => ({ html: html ?? '' }), [html]);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setFailed(false);
    setEnded(false);
    void (async () => {
      const asset = await Asset.fromModule(media[goal].video).downloadAsync();
      if (!asset.localUri) throw new Error('Demo unavailable');
      const base64 = await FileSystem.readAsStringAsync(asset.localUri, { encoding: FileSystem.EncodingType.Base64 });
      const poster = await Asset.fromModule(media[goal].poster).downloadAsync();
      if (!poster.localUri) throw new Error('Demo preview unavailable');
      const posterBase64 = await FileSystem.readAsStringAsync(poster.localUri, { encoding: FileSystem.EncodingType.Base64 });
      if (!cancelled) setHtml(jobDemoHtml(base64, posterBase64));
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [goal]);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ height: 350, borderRadius: 16, overflow: 'hidden' }}>
        {html && !failed ? <WebView
          ref={webView}
          key={goal}
          testID="onboarding.jobDemo"
          style={{ backgroundColor: 'transparent' }}
          source={source} originWhitelist={['about:*']}
          allowsInlineMediaPlayback mediaPlaybackRequiresUserAction={false}
          scrollEnabled={false}
          onMessage={(event) => {
            if (event.nativeEvent.data === 'playing') setEnded(false);
            if (event.nativeEvent.data === 'ended') setEnded(true);
            if (event.nativeEvent.data === 'failed') setFailed(true);
          }}
          onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
          onError={() => setFailed(true)}
          onRenderProcessGone={() => setFailed(true)}
          onContentProcessDidTerminate={() => setFailed(true)}
        /> : null}
        {!html || failed ? <View pointerEvents="none" style={{ position: 'absolute', width: '100%', height: '100%', backgroundColor: '#f7f6f1' }}>
          <Image source={media[goal].poster} style={{ width: '100%', height: '100%' }} resizeMode="contain" accessibilityLabel="Real Delegent AI demonstration" />
        </View> : null}
        {ended && !failed ? <View testID="onboarding.demoFinished" style={{ position: 'absolute', width: '100%', height: '100%', backgroundColor: '#f7f6f1', padding: 24, gap: 16, justifyContent: 'center' }}>
          <Text variant="title" accessibilityLiveRegion="polite">{DEMO_FINISH[goal]}</Text>
          <Text variant="body" color="textSecondary">{agentEngine ? 'Connect your own accounts to put your coworker to work.' : 'Connect your own accounts to put your coworker to work.'}</Text>
          <Button testID="onboarding.demoReplay" variant="secondary" onPress={() => {
            setEnded(false);
            webView.current?.injectJavaScript(REPLAY_DEMO_SCRIPT);
          }}>Replay demo</Button>
        </View> : null}
      </View>
      <Text variant="caption" color="textSecondary">{failed ? 'Demo preview. You can continue below.' : ended ? 'Demo complete · No audio' : '10-second demo · No audio'}</Text>
    </View>
  );
}
