// Locality's shared Supabase project.
//
// End users never configure this — they just create an account and sign in.
// Both values are meant to be public: the publishable ("anon") key only ever
// grants what Row Level Security allows, and every table is RLS-scoped to
// auth.uid(). NEVER put a `sb_secret_…` / service_role key here: it bypasses
// RLS, and anything shipped in the app or APK can be extracted from it.
export const SUPABASE_URL = "https://vergduzbaaazqsogtquf.supabase.co";

// Publishable key (Dashboard → Settings → API Keys). Safe to ship: every table
// is RLS-scoped to auth.uid(), so this key alone grants nothing.
export const SUPABASE_ANON_KEY = "sb_publishable_pYTZVCyT-HZLNQO41JQn-w_Spt3FXXQ";
