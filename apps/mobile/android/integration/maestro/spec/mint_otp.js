// Maestro runScript: mint a fresh Supabase OTP for AUTH-01.
//
// Reads env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.TEST_EMAIL from
// the YAML `env:` block. Calls Supabase admin generate_link (type magiclink)
// which returns the email_otp digits. Stores it as output.otp so the next
// `inputText: ${output.otp}` step can type the real code.
//
// Note: signInWithOtp (which the mobile app calls when the user taps
// `login.emailSubmit`) and admin.generateLink share the same OTP store keyed
// on (email, type). The latest mint wins. Calling generate_link AFTER the
// app's signInWithOtp supersedes the email-only OTP with one we can read.

const url = env.SUPABASE_URL + '/auth/v1/admin/generate_link';
const body = JSON.stringify({ type: 'magiclink', email: env.TEST_EMAIL });
const response = http.post(url, {
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'content-type': 'application/json',
  },
  body: body,
});

if (response.ok !== true) {
  output.otp = '';
  output.mintError = 'admin generate_link returned ' + response.status;
} else {
  const parsed = json(response.body);
  const otp = (parsed.email_otp || (parsed.properties && parsed.properties.email_otp) || '');
  output.otp = otp;
  output.mintError = '';
}
