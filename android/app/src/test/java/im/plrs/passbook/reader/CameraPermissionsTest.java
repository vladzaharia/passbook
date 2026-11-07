package im.plrs.passbook.reader;

import static org.junit.Assert.*;
import org.junit.Test;

public class CameraPermissionsTest {
    static final class Request implements CameraPermissions.Request {
        int grants;
        int denials;
        boolean trusted = true;
        public Object token() { return this; }
        public boolean trusted() { return trusted; }
        public void grant() { grants++; }
        public void deny() { denials++; }
    }
    @Test public void permissionDialogDoesNotCancelThePendingRequest() {
        CameraPermissions permissions = new CameraPermissions(); Request request = new Request();
        permissions.resume(); permissions.request(request, false); permissions.pause();
        assertEquals(0, request.denials);
        permissions.result(true); assertEquals(0, request.grants);
        permissions.resume(); permissions.resume();
        assertEquals(1, request.grants); assertEquals(0, request.denials);
    }
    @Test public void denialCannotBecomeAGrantAfterResume() {
        CameraPermissions permissions = new CameraPermissions(); Request request = new Request();
        permissions.resume(); permissions.request(request, false); permissions.pause(); permissions.result(false);
        permissions.resume(); permissions.result(true);
        assertEquals(0, request.grants); assertEquals(1, request.denials);
    }
    @Test public void navigationCancelsALateGrant() {
        CameraPermissions permissions = new CameraPermissions(); Request request = new Request();
        permissions.resume(); permissions.request(request, false); permissions.cancel();
        permissions.result(true); permissions.resume();
        assertEquals(0, request.grants); assertEquals(1, request.denials);
    }
    @Test public void originIsCheckedAgainWhenReturningToForeground() {
        CameraPermissions permissions = new CameraPermissions(); Request request = new Request();
        permissions.resume(); permissions.request(request, false); permissions.pause();
        request.trusted = false; permissions.result(true); permissions.resume();
        assertEquals(0, request.grants); assertEquals(1, request.denials);
    }
    @Test public void aCancelledOlderRequestCannotCancelItsReplacement() {
        CameraPermissions permissions = new CameraPermissions(); Request old = new Request(); Request next = new Request();
        permissions.resume(); permissions.request(old, false); permissions.request(next, false);
        permissions.cancel(old); permissions.result(true);
        assertEquals(1, old.denials); assertEquals(0, old.grants); assertEquals(1, next.grants);
    }
    @Test public void browserCancellationIsFinal() {
        CameraPermissions permissions = new CameraPermissions(); Request request = new Request();
        permissions.resume(); permissions.request(request, false); permissions.cancel(request); permissions.result(true);
        assertEquals(1, request.denials); assertEquals(0, request.grants);
    }
    @Test public void existingPermissionStillRequiresTheForeground() {
        CameraPermissions permissions = new CameraPermissions(); Request request = new Request();
        permissions.request(request, true); assertEquals(0, request.grants);
        permissions.resume(); assertEquals(1, request.grants);
    }
    @Test public void reportedPermissionUsesOnlyObservableFacts() {
        assertEquals("unavailable", CameraPermissions.state(false, false, false, false, false));
        assertEquals("unavailable", CameraPermissions.state(false, true, true, true, true));
        assertEquals("restricted", CameraPermissions.state(true, true, true, false, false));
        assertEquals("granted", CameraPermissions.state(true, false, true, false, true));
        assertEquals("denied", CameraPermissions.state(true, false, false, true, false));
        assertEquals("denied", CameraPermissions.state(true, false, false, false, true));
        assertEquals("unknown", CameraPermissions.state(true, false, false, false, false));
    }
}
