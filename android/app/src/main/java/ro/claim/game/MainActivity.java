package ro.claim.game;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;


import com.google.android.gms.ads.AdError;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;

import java.util.concurrent.atomic.AtomicBoolean;

/** CLAIM pentru Android: jocul (același cod ca versiunea web) rulează local, offline;
 *  modul online se conectează la serverul CLAIM. Reclame AdMob doar între runde și la cerere (recompensă). */
public class MainActivity extends Activity {
    private WebView web;
    private ConsentInformation consent;
    private final AtomicBoolean adsStarted = new AtomicBoolean(false);
    private volatile boolean adsReady = false;
    private InterstitialAd interstitial;
    private RewardedAd rewarded;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setBackgroundColor(0xFF071F43);
        setContentView(web);
        if (saved != null) web.restoreState(saved); else web.loadUrl("file:///android_asset/www/index.html");
        immersive();
        requestConsentThenAds();
    }

    // ---- consimțământ GDPR (obligatoriu în UE) apoi reclame ----
    private void requestConsentThenAds() {
        consent = UserMessagingPlatform.getConsentInformation(this);
        ConsentRequestParameters params = new ConsentRequestParameters.Builder().build();
        consent.requestConsentInfoUpdate(this, params,
            () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(this, err -> { if (consent.canRequestAds()) startAds(); }),
            err -> { if (consent.canRequestAds()) startAds(); });
        if (consent.canRequestAds()) startAds();
    }
    private void startAds() {
        if (adsStarted.getAndSet(true)) return;
        MobileAds.initialize(this, status -> runOnUiThread(() -> { adsReady = true; loadInterstitial(); loadRewarded(); }));
    }
    private void loadInterstitial() {
        InterstitialAd.load(this, BuildConfig.ADMOB_INTERSTITIAL, new AdRequest.Builder().build(), new InterstitialAdLoadCallback() {
            @Override public void onAdLoaded(InterstitialAd ad) { interstitial = ad; }
            @Override public void onAdFailedToLoad(LoadAdError e) { interstitial = null; }
        });
    }
    private void loadRewarded() {
        RewardedAd.load(this, BuildConfig.ADMOB_REWARDED, new AdRequest.Builder().build(), new RewardedAdLoadCallback() {
            @Override public void onAdLoaded(RewardedAd ad) { rewarded = ad; }
            @Override public void onAdFailedToLoad(LoadAdError e) { rewarded = null; }
        });
    }
    private void js(String kind) { runOnUiThread(() -> web.evaluateJavascript("window.ClaimAds&&ClaimAds._cb('" + kind + "')", null)); }
    private FullScreenContentCallback closer(Runnable reload) {
        return new FullScreenContentCallback() {
            @Override public void onAdDismissedFullScreenContent() { js("closed"); reload.run(); immersive(); }
            @Override public void onAdFailedToShowFullScreenContent(AdError e) { js("error"); reload.run(); }
        };
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }
    @Override public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) immersive(); }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override public void onBackPressed() {
        web.evaluateJavascript("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))", null);
    }

    class Bridge {
        @JavascriptInterface public void exit() { runOnUiThread(() -> finishAndRemoveTask()); }
        @JavascriptInterface public boolean adsAvailable() { return adsReady; }
        @JavascriptInterface public void showInterstitial() {
            runOnUiThread(() -> {
                if (interstitial == null) { js("closed"); loadInterstitial(); return; }
                interstitial.setFullScreenContentCallback(closer(MainActivity.this::loadInterstitial));
                interstitial.show(MainActivity.this); interstitial = null;
            });
        }
        @JavascriptInterface public void showRewarded() {
            runOnUiThread(() -> {
                if (rewarded == null) { js("error"); loadRewarded(); return; }
                rewarded.setFullScreenContentCallback(closer(MainActivity.this::loadRewarded));
                rewarded.show(MainActivity.this, item -> js("reward")); rewarded = null;
            });
        }
    }
}
