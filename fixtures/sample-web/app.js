let counter = 0;
let isStateA = true;

const counterEl = document.getElementById('counter-value');
const btnIncrement = document.getElementById('btn-increment');
const btnToggle = document.getElementById('btn-toggle');
const stateText = document.getElementById('current-state-text');
const portDisplay = document.getElementById('port-display');

if (portDisplay) {
  portDisplay.textContent = window.location.port || '80';
}

if (btnIncrement) {
  btnIncrement.addEventListener('click', () => {
    counter++;
    counterEl.textContent = counter.toString();
  });
}

if (btnToggle) {
  btnToggle.addEventListener('click', () => {
    isStateA = !isStateA;
    if (isStateA) {
      stateText.innerHTML = 'Active State: <strong>State A (Baseline)</strong>';
    } else {
      stateText.innerHTML = 'Active State: <strong>State B (Toggled)</strong>';
    }
  });
}
