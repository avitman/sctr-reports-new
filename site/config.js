// Supabase public credentials — anon key is safe to expose client-side.
// Supabase Row Level Security controls what anonymous users can read/write.
window.SCTR_CONFIG = {
  supabaseUrl: 'YOUR_SUPABASE_URL',
  supabaseKey: 'YOUR_SUPABASE_ANON_KEY',
};
