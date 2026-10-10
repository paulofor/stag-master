const $ = (id) => document.getElementById(id);
const state = {
  csrf: "",
  selected: "",
  detail: null,
  page: 1,
  search: "",
  busy: false,
  offlineHours: 48,
  hasPrevious: false,
  hasNext: false,
};
const statusNames = { active: "Ativa", expired: "Vencida", revoked: "Revogada" };
const date = (value) =>
  new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = !message;
}
async function api(path, method = "GET", data) {
  let res;
  try {
    res = await fetch(`/api/admin/${path}`, {
      method,
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", "x-csrf-token": state.csrf },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  } catch {
    throw new Error(
      "Não foi possível confirmar a operação. Atualize a lista antes de tentar novamente.",
    );
  }
  const value = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== "login" && path !== "password") showLogin();
    throw new Error(value.error?.message || "Operação não concluída.");
  }
  return value;
}
async function run(button, action, errorId) {
  if (state.busy) return;
  state.busy = true;
  const disabled = new Map();
  for (const control of document.querySelectorAll("button,input,textarea")) {
    if (control.closest("#key-dialog")) continue;
    disabled.set(control, control.disabled);
    control.disabled = true;
  }
  document.body.setAttribute("aria-busy", "true");
  $("working").hidden = false;
  if (errorId) $(errorId).hidden = true;
  try {
    await action();
  } catch (e) {
    if (errorId) {
      $(errorId).textContent = e.message;
      $(errorId).hidden = false;
    } else notice(e.message, true);
  } finally {
    state.busy = false;
    for (const [control, value] of disabled) control.disabled = value;
    for (const control of document.querySelectorAll("button"))
      if (!disabled.has(control) && !control.closest("#key-dialog")) control.disabled = false;
    $("previous").disabled = !state.hasPrevious;
    $("next").disabled = !state.hasNext;
    document.body.removeAttribute("aria-busy");
    $("working").hidden = true;
  }
}
function showLogin() {
  state.csrf = "";
  state.selected = "";
  state.detail = null;
  $("dashboard").hidden = true;
  $("account").hidden = true;
  $("login-view").hidden = false;
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
}
function showDashboard(session) {
  state.csrf = session.csrf;
  $("username").textContent = session.username;
  $("account").hidden = false;
  $("dashboard").hidden = false;
  $("login-view").hidden = true;
}
function node(tag, text, className) {
  const e = document.createElement(tag);
  if (tag === "button") e.disabled = state.busy;
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function badge(status) {
  return node("span", statusNames[status], `badge ${status}`);
}
async function refresh() {
  const [summary, list] = await Promise.all([
    api("summary"),
    api(`licenses?page=${state.page}&search=${encodeURIComponent(state.search)}`),
  ]);
  state.offlineHours = summary.offlineHours;
  $("stat-active").textContent = summary.active;
  $("stat-total").textContent = `${summary.total} no total`;
  $("stat-devices").textContent = summary.devices;
  $("stat-expiring").textContent = summary.expiring;
  $("stat-ended").textContent = summary.expired + summary.revoked;
  $("stat-ended-detail").textContent = `${summary.expired} vencidas · ${summary.revoked} revogadas`;
  $("licenses").replaceChildren();
  for (const l of list.licenses) {
    const b = node("button", undefined, `license-row${state.selected === l.id ? " selected" : ""}`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.selected === l.id));
    const info = node("span");
    info.append(
      node("strong", l.label),
      node("small", `${l.activeDevices}/${l.maxDevices} computadores · até ${date(l.expiresAt)}`),
    );
    b.append(info, badge(l.status));
    b.addEventListener("click", () =>
      run(b, async () => {
        state.selected = l.id;
        await refresh();
      }),
    );
    $("licenses").append(b);
  }
  if (!list.licenses.length) {
    const empty = node("div", undefined, "empty");
    empty.append(
      node("h2", "Nenhuma licença encontrada"),
      node("p", "Emita uma licença ou ajuste a busca."),
    );
    $("licenses").append(empty);
  }
  $("page-label").textContent = `Página ${list.page} · ${list.total} licenças`;
  state.hasPrevious = state.page > 1;
  state.hasNext = state.page * list.pageSize < list.total;
  $("previous").disabled = state.busy || !state.hasPrevious;
  $("next").disabled = state.busy || !state.hasNext;
  if (state.selected) {
    state.detail = await api(`licenses/${state.selected}`);
    renderDetail();
  } else {
    $("selected-detail").hidden = true;
    $("empty-detail").hidden = false;
  }
}
function localDate(value) {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function renderDetail() {
  const { license: l, devices } = state.detail;
  $("selected-detail").hidden = false;
  $("empty-detail").hidden = true;
  $("detail-title").textContent = l.label;
  $("detail-status").textContent = statusNames[l.status];
  $("detail-status").className = `badge ${l.status}`;
  $("detail-hint").textContent =
    `Código terminado em ${l.keyHint} · criada em ${date(l.createdAt)}`;
  const f = $("edit-form").elements;
  f.label.value = l.label;
  f.expiresAt.value = localDate(l.expiresAt);
  f.maxDevices.value = l.maxDevices;
  $("device-count").textContent = `${l.activeDevices} de ${l.maxDevices} em uso`;
  $("devices").replaceChildren();
  for (const d of devices) {
    const row = node("div", undefined, "device");
    const info = node("div");
    info.append(
      node("strong", d.name),
      node("small", `${d.disabled ? "Liberado" : "Último contato"} · ${date(d.lastSeenAt)}`),
    );
    row.append(info);
    if (!d.disabled) {
      const b = node("button", "Liberar", "quiet");
      b.setAttribute("aria-label", `Liberar ${d.name}`);
      b.addEventListener("click", async () => {
        if (
          await confirmAction(
            "Liberar computador?",
            `A instalação “${d.name}” deixará de renovar a autorização. A vaga ficará disponível para outra máquina.`,
          )
        )
          await run(b, async () => {
            await api(`licenses/${l.id}/devices/${d.id}`, "DELETE", {});
            await refresh();
            notice("Computador liberado.");
          });
      });
      row.append(b);
    }
    $("devices").append(row);
  }
  if (!devices.length) $("devices").append(node("p", "Nenhum computador ativado.", "muted"));
  $("revoke").hidden = l.status === "revoked";
  $("restore").hidden = l.status !== "revoked";
  $("offline-note").textContent =
    `Revogação, liberação e troca de código impedem novas renovações. Autorizações já emitidas podem durar até ${state.offlineHours} h, limitadas ao vencimento da licença.`;
}
function confirmAction(title, text) {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  const dialog = $("confirm-dialog");
  dialog.showModal();
  return new Promise((resolve) => {
    let answer = false;
    const yes = () => {
      answer = true;
      dialog.close();
    };
    const no = () => dialog.close();
    const closed = () => {
      $("confirm-yes").removeEventListener("click", yes);
      $("confirm-no").removeEventListener("click", no);
      resolve(answer);
    };
    $("confirm-yes").addEventListener("click", yes);
    $("confirm-no").addEventListener("click", no);
    dialog.addEventListener("close", closed, { once: true });
  });
}
function displayKey(key) {
  $("license-key").value = key;
  $("copy-status").textContent = "";
  $("key-dialog").showModal();
}
$("key-dialog").addEventListener("close", () => {
  $("license-key").value = "";
});
for (const b of document.querySelectorAll("[data-close]"))
  b.addEventListener("click", () => {
    if (b.dataset.close === "key-dialog" || !state.busy) $(b.dataset.close).close();
  });
$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  run(f.querySelector("button"), async () => {
    const session = await api("login", "POST", {
      username: f.elements.username.value,
      password: f.elements.password.value,
    });
    f.elements.password.value = "";
    showDashboard(session);
    await refresh();
    notice("");
  });
});
$("logout").addEventListener("click", (e) =>
  run(e.currentTarget, async () => {
    await api("logout", "POST", {});
    showLogin();
    notice("");
  }),
);
$("new-license").addEventListener("click", () => {
  $("create-error").hidden = true;
  $("create-dialog").showModal();
});
$("create-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  run(
    f.querySelector("button[type=submit]"),
    async () => {
      const result = await api("licenses", "POST", {
        label: f.elements.label.value,
        durationDays: Number(f.elements.durationDays.value),
        maxDevices: Number(f.elements.maxDevices.value),
      });
      $("create-dialog").close();
      f.reset();
      state.selected = result.license.id;
      displayKey(result.licenseKey);
      await refresh();
      notice("Licença emitida.");
    },
    "create-error",
  );
});
$("copy-key").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    await navigator.clipboard.writeText($("license-key").value);
    $("copy-status").textContent = "Código copiado.";
  } catch {
    $("license-key").select();
    $("copy-status").textContent = "Selecione o código e use Ctrl+C para copiar.";
  } finally {
    button.disabled = false;
  }
});
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  run(e.currentTarget.querySelector("button"), async () => {
    state.search = $("search").value;
    state.page = 1;
    await refresh();
  });
});
$("reload").addEventListener("click", (e) =>
  run(e.currentTarget, async () => {
    await refresh();
    notice("Lista atualizada.");
  }),
);
for (const [id, direction] of [
  ["previous", -1],
  ["next", 1],
])
  $(id).addEventListener("click", (e) =>
    run(e.currentTarget, async () => {
      state.page += direction;
      await refresh();
    }),
  );
$("edit-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  run(f.querySelector("button[type=submit]"), async () => {
    await api(`licenses/${state.selected}`, "PATCH", {
      label: f.elements.label.value,
      expiresAt: new Date(f.elements.expiresAt.value).toISOString(),
      maxDevices: Number(f.elements.maxDevices.value),
    });
    await refresh();
    notice("Alterações salvas.");
  });
});
$("extend").addEventListener("click", () => {
  const field = $("edit-form").elements.expiresAt;
  field.value = localDate(
    new Date(Math.max(Date.now(), new Date(field.value).getTime()) + 30 * 86400_000),
  );
});
for (const [action, title, text] of [
  [
    "revoke",
    "Revogar licença?",
    "O servidor recusará novas ativações e renovações. Você poderá reativar depois.",
  ],
  [
    "restore",
    "Reativar licença?",
    "As instalações vinculadas poderão renovar a autorização enquanto a licença estiver válida.",
  ],
  [
    "rotate",
    "Gerar novo código?",
    "O código anterior deixará de funcionar e os computadores deverão ser ativados novamente. Guarde o novo código.",
  ],
])
  $(action).addEventListener("click", async (e) => {
    const button = e.currentTarget;
    if (await confirmAction(title, text))
      await run(button, async () => {
        const result = await api(`licenses/${state.selected}/${action}`, "POST", {});
        if (result.licenseKey) displayKey(result.licenseKey);
        await refresh();
        notice("Licença atualizada.");
      });
  });
$("password-button").addEventListener("click", () => {
  $("password-form").reset();
  $("password-error").hidden = true;
  $("password-dialog").showModal();
});
$("password-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  run(
    f.querySelector("button[type=submit]"),
    async () => {
      await api("password", "POST", {
        currentPassword: f.elements.currentPassword.value,
        newPassword: f.elements.newPassword.value,
      });
      f.reset();
      showLogin();
      notice("Senha alterada. Entre novamente.");
    },
    "password-error",
  );
});
const auditNames = {
  "admin.login": "Entrada no painel",
  "admin.password_changed": "Senha alterada",
  "license.created": "Licença emitida",
  "license.updated": "Licença editada",
  "license.revoke": "Licença revogada",
  "license.restore": "Licença reativada",
  "license.rotate": "Código substituído",
  "device.activate": "Computador ativado",
  "device.refresh": "Autorização renovada",
  "device.deactivate": "Instalação desativada",
  "device.released": "Computador liberado",
};
$("load-audit").addEventListener("click", (e) =>
  run(e.currentTarget, async () => {
    const result = await api("audit");
    $("audit-list").replaceChildren(
      ...result.events.map((a) =>
        node(
          "li",
          `${date(a.createdAt)} · ${auditNames[a.action] || "Evento"}${a.licenseId ? ` · ${a.licenseId.slice(0, 8)}` : ""}`,
        ),
      ),
    );
  }),
);
try {
  const session = await api("session");
  showDashboard(session);
  await refresh();
} catch (e) {
  showLogin();
  if (!e.message.includes("Entre para") && !e.message.includes("sessão terminou"))
    notice(e.message, true);
}
