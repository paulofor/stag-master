import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";

// Browser-only, synthetic controls. No accounts, remote APIs, storage or private data.
function Combo({ searchable = false }: { searchable?: boolean }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState("");
  const id = searchable ? "search-combo" : "custom-combo";
  const name = searchable ? "Cidade sintética" : "Categoria sintética";
  const choices = searchable
    ? ["Recife", "Curitiba"]
    : ["Arquitetura", "Programação", "Indisponível", "Excluir projeto sintético"];
  const props = {
    id,
    role: "combobox",
    "aria-label": name,
    "aria-controls": `${id}-list`,
    "aria-expanded": open,
    "aria-haspopup": "listbox" as const,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "ArrowDown") setOpen(true);
      if (event.key === "Escape") setOpen(false);
    },
  };
  return (
    <section>
      {searchable ? (
        <input
          {...props}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setOpen(true);
          }}
        />
      ) : (
        <div
          {...props}
          tabIndex={0}
          onMouseDown={(event) => {
            event.preventDefault();
            setOpen(!open);
          }}
        >
          Escolher categoria
        </div>
      )}
      <p id={`${id}-result`}>{chosen || "Nenhuma opção escolhida"}</p>
      {open &&
        createPortal(
          <div id={`${id}-list`} role="listbox" aria-label={`Opções de ${name}`}>
            {choices
              .filter((choice) => choice.toLowerCase().includes(filter.toLowerCase()))
              .map((choice) => (
                <div
                  key={choice}
                  role="option"
                  aria-disabled={choice === "Indisponível"}
                  aria-selected={choice === chosen}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    if (choice !== "Indisponível") {
                      setChosen(choice);
                      setOpen(false);
                    }
                  }}
                >
                  {choice}
                </div>
              ))}
          </div>,
          document.body,
        )}
    </section>
  );
}

function Controls() {
  const [native, setNative] = useState("SYNTHETIC_INTERNAL_INITIAL");
  const [changes, setChanges] = useState(0);
  return (
    <>
      <h1>Combos sintéticos</h1>
      <label htmlFor="native">Ambiente de teste</label>
      <select
        id="native"
        value={native}
        onChange={(event) => {
          setNative(event.target.value);
          setChanges(changes + 1);
        }}
      >
        <option value="SYNTHETIC_INTERNAL_INITIAL">Inicial</option>
        <option value="SYNTHETIC_INTERNAL_LOCAL">Desenvolvimento local</option>
        <option value="SYNTHETIC_INTERNAL_DUPLICATE_A">Duplicada</option>
        <option value="SYNTHETIC_INTERNAL_DUPLICATE_B">Duplicada</option>
        <option value="SYNTHETIC_INTERNAL_DISABLED" disabled>
          Bloqueada
        </option>
        <optgroup label="Grupo desabilitado" disabled>
          <option value="SYNTHETIC_INTERNAL_GROUP">Bloqueada pelo grupo</option>
        </optgroup>
        <option value="SYNTHETIC_INTERNAL_HIDDEN" hidden>
          Oculta
        </option>
        <option value="SYNTHETIC_INTERNAL_CRITICAL">Excluir projeto sintético</option>
      </select>
      <p id="native-changes">Alterações: {changes}</p>
      <Combo />
      <Combo searchable />
      <label id="pointer-label">Lista por ponteiro</label>
      <PointerCombo />
      <label htmlFor="payment">Bandeira sintética</label>
      <select id="payment" autoComplete="cc-type">
        <option>A</option>
        <option>B</option>
      </select>
      <select id="multiple" aria-label="Lista múltipla" multiple defaultValue={["a", "b"]}>
        <option>a</option>
        <option>b</option>
      </select>
      <select id="duplicates" aria-label="Valores repetidos" defaultValue="initial">
        <option value="initial">Inicial</option>
        <option value="same">Primeira</option>
        <option value="same">Segunda</option>
      </select>
      <select id="long" aria-label="Lista longa">
        {Array.from({ length: 60 }, (_, index) => (
          <option key={index} value={`SYNTHETIC_INTERNAL_${index}`}>
            Opção {index}
          </option>
        ))}
      </select>
      <select
        id="reverts"
        aria-label="Seleção recusada"
        onChange={(event) => {
          event.currentTarget.selectedIndex = 0;
        }}
      >
        <option>Inicial</option>
        <option>Outra</option>
      </select>
    </>
  );
}

function PointerCombo() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(false);
  return (
    <>
      <div
        id="pointer"
        role="combobox"
        aria-labelledby="pointer-label"
        aria-controls="pointer-list"
        aria-expanded={open}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          setOpen(!open);
        }}
      >
        Escolher
      </div>
      {open && (
        <div id="pointer-list" role="listbox" aria-label="Lista de ponteiro">
          <div
            role="option"
            onClick={() => {
              setSelected(true);
              setOpen(false);
            }}
          >
            Opção por clique
          </div>
        </div>
      )}
      <p id="pointer-result">{selected ? "Escolhida" : "Nenhuma"}</p>
    </>
  );
}

createRoot(document.getElementById("combos")!).render(<Controls />);
