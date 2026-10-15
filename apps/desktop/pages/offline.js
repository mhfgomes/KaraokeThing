const host = new URLSearchParams(location.search).get('host');
if (host) document.getElementById('host').textContent = host;
