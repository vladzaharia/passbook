package im.plrs.passbook.reader;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.InputType;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class SettingsDialog {
    public interface Saved { void accept(ReaderConfig config); }
    private SettingsDialog() {}
    public static void show(Activity activity, ReaderConfig config, Saved saved, Runnable closed) {
        LinearLayout fields = new LinearLayout(activity);
        fields.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (20 * activity.getResources().getDisplayMetrics().density);
        fields.setPadding(padding, padding, padding, padding);
        EditText url = field(activity, fields, "Verifier HTTPS URL (empty for diagnostics)", config.verifierUrl(), false);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        EditText ids = field(activity, fields, "Pass Type IDs (one per line)", String.join("\n", config.passTypeIds()), true);
        EditText action = field(activity, fields, "Scanner broadcast action (optional)", config.barcodeAction(), false);
        EditText extra = field(activity, fields, "Scanner text extra", config.barcodeExtra(), false);
        TextView error = new TextView(activity);
        error.setTextColor(0xffb3261e);
        fields.addView(error);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(fields);
        AlertDialog dialog = new AlertDialog.Builder(activity).setTitle("Reader settings")
            .setView(scroll).setNegativeButton("Cancel", null).setPositiveButton("Save", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(button -> {
            try {
                ReaderConfig next = new ReaderConfig(url.getText().toString(), ReaderConfig.parseIds(ids.getText().toString()),
                    action.getText().toString().trim(), extra.getText().toString().trim());
                next.save(activity);
                saved.accept(next);
                dialog.dismiss();
            } catch (IllegalArgumentException exception) { error.setText(exception.getMessage()); }
        }));
        dialog.setOnDismissListener(ignored -> closed.run());
        dialog.show();
    }

    private static EditText field(Activity activity, LinearLayout parent, String label, String value, boolean multiline) {
        TextView caption = new TextView(activity);
        caption.setText(label);
        parent.addView(caption);
        EditText input = new EditText(activity);
        input.setText(value);
        input.setContentDescription(label);
        input.setSingleLine(!multiline);
        input.setInputType(InputType.TYPE_CLASS_TEXT | (multiline ? InputType.TYPE_TEXT_FLAG_MULTI_LINE : 0));
        input.setMinHeight((int) (48 * activity.getResources().getDisplayMetrics().density));
        parent.addView(input);
        return input;
    }
}
