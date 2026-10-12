const form = document.getElementById('form');
const input = document.getElementById('link');
const button = document.getElementById('save');
const error = document.getElementById('error');

window.stageSetup.current().then((link) => { if (link && !input.value) input.value = link; });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  button.disabled = true;
  button.textContent = 'Connecting…';
  error.hidden = true;
  // On success the app restarts with the new host, so only failures come back.
  const result = await window.stageSetup.save(input.value);
  if (result?.error) {
    error.textContent = result.error;
    error.hidden = false;
    button.disabled = false;
    button.textContent = 'Connect';
  }
});
