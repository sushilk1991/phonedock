package dev.phonedock.sample;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Switch;
import android.widget.TextView;

/** PhoneDock Sample: a tiny fixture app for end-to-end tests (mirrors fixtures/ios-sample). */
public class MainActivity extends Activity {
    private static final String TAG = "PhoneDockSample";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        Log.i(TAG, "MainActivity created");

        // targetSdk 35+ is edge-to-edge: keep the content clear of the status bar, navigation bar and keyboard.
        if (Build.VERSION.SDK_INT >= 30) {
            View root = findViewById(R.id.root);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                int top = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()).top;
                int bottom = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime()).bottom;
                v.setPadding(0, top, 0, bottom);
                return insets;
            });
        }

        final EditText name = findViewById(R.id.nameField);
        final TextView greeting = findViewById(R.id.greetingLabel);
        Button greet = findViewById(R.id.greetButton);
        greet.setOnClickListener(v -> {
            String n = name.getText().toString().trim();
            String text = "Hello, " + (n.isEmpty() ? "World" : n) + "!";
            greeting.setText(text);
            Log.i(TAG, "Greeted: " + text);
        });

        final TextView status = findViewById(R.id.notifyStatus);
        Switch toggle = findViewById(R.id.notifyToggle);
        toggle.setOnCheckedChangeListener((b, on) -> {
            status.setText(on ? R.string.notifications_on : R.string.notifications_off);
            Log.i(TAG, "Notifications " + (on ? "on" : "off"));
        });

        final EditText password = findViewById(R.id.passwordField);
        final TextView signInStatus = findViewById(R.id.signInStatus);
        Button signIn = findViewById(R.id.signInButton);
        signIn.setOnClickListener(v -> {
            boolean ok = password.getText().length() > 0;
            signInStatus.setText(ok ? R.string.signed_in : R.string.signed_out);
            Log.i(TAG, ok ? "Signed in" : "Sign in: empty password");
        });
        // Return on the keyboard signs in too.
        password.setOnEditorActionListener((v, actionId, ev) -> { signIn.performClick(); return true; });

        Button crash = findViewById(R.id.crashButton);
        crash.setOnClickListener(v -> {
            Log.e(TAG, "Crash button tapped; throwing");
            throw new IllegalStateException("PhoneDock sample crash (Crash button)");
        });
    }
}
