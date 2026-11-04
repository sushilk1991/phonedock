package dev.phonedock.sample;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Test hook: posts a heads-up notification (a high-importance channel pops on screen over the app in front), so the
 *  e2e test can check that a heads-up never becomes the window PhoneDock describes or scrolls in.
 *  adb shell pm grant dev.phonedock.sample android.permission.POST_NOTIFICATIONS
 *  adb shell am broadcast -n dev.phonedock.sample/.NotifyReceiver --es title T --es text X */
public final class NotifyReceiver extends BroadcastReceiver {
  private static final String CHANNEL = "pdtest-headsup";

  @Override
  public void onReceive(Context context, Intent intent) {
    NotificationManager nm = context.getSystemService(NotificationManager.class);
    if (nm == null) return;
    NotificationChannel ch = new NotificationChannel(CHANNEL, "Heads-up test", NotificationManager.IMPORTANCE_HIGH);
    nm.createNotificationChannel(ch);
    String title = intent.getStringExtra("title");
    String text = intent.getStringExtra("text");
    Notification n = new Notification.Builder(context, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_notify_chat)
        .setContentTitle(title != null ? title : "pdtest")
        .setContentText(text != null ? text : "hello")
        .setCategory(Notification.CATEGORY_MESSAGE)
        .setAutoCancel(true)
        .build();
    nm.notify((int) (System.currentTimeMillis() & 0x7fffffff), n);
  }
}
