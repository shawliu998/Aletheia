"use strict";

const form = document.getElementById("connection-form");
const input = document.getElementById("workspace-url");
const connectButton = document.getElementById("connect-button");
const cancelButton = document.getElementById("cancel-button");
const error = document.getElementById("connection-error");

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  input.setAttribute("aria-invalid", "true");
  input.focus();
}

function clearError() {
  error.textContent = "";
  error.hidden = true;
  input.removeAttribute("aria-invalid");
}

function friendlyError(reason) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return (
    message.split("Error: ").at(-1) ||
    "Vera could not save this workspace address."
  );
}

async function initialize() {
  const parameters = new URLSearchParams(window.location.search);
  const initialError = parameters.get("error");
  if (initialError) showError(initialError);
  try {
    const info = await window.veraDesktop.getInfo();
    if (info.currentAppUrl) input.value = info.currentAppUrl;
    cancelButton.hidden = !info.canCancelConnectionSetup;
  } catch {
    showError("Vera could not read the desktop connection state.");
  }
  if (!initialError) input.focus();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const value = input.value.trim();
  if (!value) {
    showError("Enter your Vera workspace address.");
    return;
  }
  connectButton.disabled = true;
  cancelButton.disabled = true;
  connectButton.textContent = "Connecting…";
  try {
    await window.veraDesktop.configureConnection(value);
  } catch (reason) {
    showError(friendlyError(reason));
    connectButton.disabled = false;
    cancelButton.disabled = false;
    connectButton.textContent = "Connect";
  }
});

cancelButton.addEventListener("click", async () => {
  clearError();
  cancelButton.disabled = true;
  try {
    await window.veraDesktop.cancelConnectionSetup();
  } catch (reason) {
    showError(friendlyError(reason));
    cancelButton.disabled = false;
  }
});

void initialize();
