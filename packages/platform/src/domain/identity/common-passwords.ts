/**
 * Well-known weak passwords of 10+ characters (shorter ones already fail the
 * length rule). Deliberately small; set COMMON_PASSWORDS_FILE to add a large
 * published list (one password per line).
 */
export const BUILT_IN_COMMON_PASSWORDS: readonly string[] = [
  '1234567890', '0123456789', '0987654321', '9876543210', '1234512345', '1122334455', '1111111111', '0000000000',
  '12345678910', '123456789a', 'a123456789', '123456789q', 'q123456789', '1q2w3e4r5t', '1q2w3e4r5t6y', 'zaq12wsxcde3',
  'password12', 'password123', 'password1234', 'password12345', 'password!1', 'password@123', 'password#123', 'passw0rd123',
  'p@ssw0rd123', 'p@ssword123', 'passwordpassword', 'mypassword', 'mypassword1', 'mypassword123', 'newpassword', 'newpassword1',
  'changeme123', 'changemenow', 'welcome123', 'welcome1234', 'welcome@123', 'letmein123', 'letmein1234', 'iloveyou12',
  'iloveyou123', 'iloveyou1234', 'qwertyuiop', 'qwertyuiop1', 'qwertyuiop123', 'asdfghjkl1', 'asdfghjkl123', 'zxcvbnm123',
  'qwerty12345', 'qwerty123456', 'qwertyqwerty', 'abcdefghij', 'abcdefgh12', 'abc1234567', 'abcd123456', 'abc123abc123',
  'administrator', 'admin12345', 'admin123456', 'admin@1234', 'superman123', 'batman1234', 'football123', 'baseball123',
  'cricket123', 'cricket1234', 'sunshine123', 'princess123', 'monkey12345', 'dragon12345', 'master12345', 'shadow12345',
  'computer123', 'internet123', 'whatever123', 'trustno1234', 'starwars123', 'pokemon1234', 'samsung1234', 'india12345',
  'india@1234', 'bharat1234', 'mumbai12345', 'delhi12345', 'kolkata1234', 'chennai1234', 'bangalore123', 'hyderabad123',
  'jaishreeram', 'jaihind123', 'omnamahshivaya', 'harekrishna', 'ganesh12345', 'krishna1234', 'saibaba1234', 'lakshmi1234',
];

export function normalisePassword(p: string): string {
  return p.normalize('NFKC').toLowerCase();
}
