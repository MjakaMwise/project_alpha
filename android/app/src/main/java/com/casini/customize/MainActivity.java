package com.casini.customize;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.content.FileProvider;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.IOException;

public final class MainActivity extends Activity {
    private static final String SHOWROOM_URL = "http://localhost:4175/";
    private static final int CHOOSE_PHOTO = 1;

    private WebView showroom;
    private ValueCallback<Uri[]> photoCallback;
    private Uri cameraPhoto;
    private LinearLayout connectionError;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(17, 18, 16));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            var bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        showroom = new WebView(this);
        showroom.setBackgroundColor(Color.rgb(17, 18, 16));
        showroom.getSettings().setJavaScriptEnabled(true);
        showroom.addJavascriptInterface(new RoomDisplay(), "CustomizeRoomDisplay");
        showroom.getSettings().setDomStorageEnabled(true);
        showroom.getSettings().setAllowFileAccess(false);
        showroom.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                return !"http".equals(url.getScheme()) || !"localhost".equals(url.getHost())
                        || url.getPort() != 4175;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showConnectionError();
            }
        });
        showroom.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return choosePhoto(callback, params);
            }
        });
        root.addView(showroom, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        startShowroom();
    }

    public final class RoomDisplay {
        @JavascriptInterface
        public void setFullscreen(boolean fullscreen) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                var controller = new WindowInsetsControllerCompat(getWindow(), showroom);
                controller.setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                if (fullscreen) {
                    controller.hide(WindowInsetsCompat.Type.systemBars());
                } else {
                    controller.show(WindowInsetsCompat.Type.systemBars());
                }
            });
        }
    }

    private void startShowroom() {
        LocalServer.start(this).whenComplete((ignored, error) -> runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            if (error != null) {
                android.util.Log.e("Customize", "Cannot start local Rust server", error);
                showConnectionError();
            } else {
                showroom.loadUrl(SHOWROOM_URL);
            }
        }));
    }

    @Override
    protected void onDestroy() {
        finishPhoto(null);
        ((ViewGroup) showroom.getParent()).removeView(showroom);
        showroom.destroy();
        super.onDestroy();
    }

    private void showConnectionError() {
        if (connectionError != null) return;
        FrameLayout root = (FrameLayout) showroom.getParent();
        connectionError = new LinearLayout(this);
        connectionError.setOrientation(LinearLayout.VERTICAL);
        connectionError.setGravity(android.view.Gravity.CENTER);
        connectionError.setBackgroundColor(Color.rgb(17, 18, 16));
        TextView message = new TextView(this);
        message.setText("Could not start the local showroom. Please try again.");
        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setOnClickListener(view -> {
            root.removeView(connectionError);
            connectionError = null;
            startShowroom();
        });
        connectionError.addView(message);
        connectionError.addView(retry);
        root.addView(connectionError, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private boolean choosePhoto(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (photoCallback != null) photoCallback.onReceiveValue(null);
        photoCallback = callback;
        cameraPhoto = null;
        if (params.isCaptureEnabled()) {
            try {
                File directory = new File(getCacheDir(), "camera");
                if (!directory.exists() && !directory.mkdirs()) throw new IOException("Cannot create camera cache");
                File file = File.createTempFile("angle-", ".jpg", directory);
                cameraPhoto = FileProvider.getUriForFile(this, getPackageName() + ".photos", file);
                Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                camera.putExtra(MediaStore.EXTRA_OUTPUT, cameraPhoto);
                camera.setClipData(ClipData.newRawUri("Customize photo", cameraPhoto));
                camera.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                startActivityForResult(camera, CHOOSE_PHOTO);
                return true;
            } catch (ActivityNotFoundException | IOException unavailable) {
                cameraPhoto = null;
            }
        }
        try {
            startActivityForResult(params.createIntent(), CHOOSE_PHOTO);
        } catch (ActivityNotFoundException unavailable) {
            finishPhoto(null);
        }
        return true;
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != CHOOSE_PHOTO) return;
        Uri[] photos = cameraPhoto != null && result == RESULT_OK
                ? new Uri[]{cameraPhoto}
                : WebChromeClient.FileChooserParams.parseResult(result, data);
        if (photos != null) {
            photos = java.util.Arrays.stream(photos)
                    .filter(uri -> uri != null && "content".equals(uri.getScheme()))
                    .toArray(Uri[]::new);
        }
        finishPhoto(photos != null && photos.length > 0 ? photos : null);
    }

    private void finishPhoto(Uri[] files) {
        if (photoCallback != null) photoCallback.onReceiveValue(files);
        photoCallback = null;
        cameraPhoto = null;
    }
}
