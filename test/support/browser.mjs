// Stands in for a browser: follows the authorize redirect into the CLI's loopback listener.
const url = process.argv[2];
const first = await fetch(url, { redirect: 'manual' });
const location = first.headers.get('location');
if (location) await fetch(location, { redirect: 'manual' });
