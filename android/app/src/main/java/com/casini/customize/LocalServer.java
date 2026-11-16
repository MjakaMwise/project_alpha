package com.casini.customize;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.CompletableFuture;

/** Owns the Rust server for the lifetime of the application process. */
final class LocalServer {
    private static CompletableFuture<Void> startup;

    private static native void startNative(String root, String database);

    static synchronized CompletableFuture<Void> start(Context context) {
        if (startup != null && !startup.isCompletedExceptionally()) return startup;
        Context app = context.getApplicationContext();
        CompletableFuture<Void> result = new CompletableFuture<>();
        startup = result;
        new Thread(() -> {
            try {
                System.loadLibrary("customize");
                File root = new File(app.getFilesDir(), "showroom");
                copyAssets(app.getAssets(), "showroom", root);
                startNative(root.getAbsolutePath(),
                        new File(app.getFilesDir(), "shoppers.json").getAbsolutePath());
                result.complete(null);
            } catch (IOException | RuntimeException | LinkageError error) {
                result.completeExceptionally(error);
            }
        }, "customize-startup").start();
        return result;
    }

    private static void copyAssets(AssetManager assets, String source, File destination)
            throws IOException {
        String[] children = assets.list(source);
        if (children != null && children.length > 0) {
            if (!destination.isDirectory() && !destination.mkdirs()) {
                throw new IOException("Cannot create showroom directory");
            }
            for (String child : children) {
                copyAssets(assets, source + "/" + child, new File(destination, child));
            }
        } else {
            try (InputStream input = assets.open(source);
                 FileOutputStream output = new FileOutputStream(destination)) {
                byte[] buffer = new byte[16384];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
        }
    }

    private LocalServer() {}
}
