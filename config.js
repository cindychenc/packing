// Public settings for the Suitcase manager. The publishable key is meant to be in client code:
// row-level security in the database decides what each signed-in person can read or change.
// Never put the secret / service_role key here.
window.SUITCASE_CONFIG = {
  supabaseUrl: 'https://uebwqwyecdlbtmuxnwdm.supabase.co',
  supabaseKey: 'sb_publishable_sbJpxl4SAAQzNxpggX3_cQ_oDQjGm1c',
  carryonUrl: 'https://carryon.boringcase.com/',
  // Mapbox public token (pk.), limited in the Mapbox account to packing.boringcase.com and localhost:8000.
  mapboxToken: ''
};
