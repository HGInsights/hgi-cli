// Stands in for a user who clicks "Deny" on the consent screen.
const first = await fetch(process.argv[2], { redirect: 'manual' });
const location = new URL(first.headers.get('location'));
const state = location.searchParams.get('state');
await fetch(`${location.origin}${location.pathname}?error=access_denied&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
