// Real, pinned Angular/PrimeNG components; loopback only, with synthetic dates.
import "zone.js";
import "@angular/compiler";
import { Component, importProvidersFrom } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { CalendarModule } from "primeng/calendar";
import { PrimeNGConfig } from "primeng/api";

class DateControls {
  month = null;
  day = null;
  initial = new Date(2026, 8, 15);
  min = new Date(2024, 0, 1);
  max = new Date(2028, 11, 31);
  blocked = [new Date(2026, 8, 18)];
  native = "";
  nativeChanges = 0;
}
Component({
  selector: "date-controls",
  standalone: true,
  imports: [CommonModule, FormsModule, CalendarModule],
  template: `
    <h1>Calendários sintéticos</h1>
    <label for="competencia">Competência sintética</label>
    <p-calendar inputId="competencia" [(ngModel)]="month" view="month" dateFormat="mm/yy"
      [readonlyInput]="true" [showIcon]="true" [defaultDate]="initial" [minDate]="min" [maxDate]="max" appendTo="body" />
    <p id="month-result">{{month ? (month | date:'MM/yyyy') : 'Sem competência'}}</p>
    <label for="dia">Dia sintético</label>
    <p-calendar inputId="dia" [(ngModel)]="day" dateFormat="dd/mm/yy" [readonlyInput]="true"
      [defaultDate]="initial" [minDate]="min" [maxDate]="max" [disabledDates]="blocked" appendTo="body" />
    <p id="day-result">{{day ? (day | date:'dd/MM/yyyy') : 'Sem dia'}}</p>
    <label>Data nativa <input id="native-date" type="date" [(ngModel)]="native"
      (ngModelChange)="nativeChanges = nativeChanges + 1" min="2024-01-01" max="2028-12-31"></label>
    <p id="native-result">{{native}} / {{nativeChanges}}</p>
    <label>Mês nativo <input id="native-month" type="month" min="2026-01" max="2026-12" step="2"></label>
    <label>Data e hora nativas <input id="native-datetime" type="datetime-local" step="60"></label>
    <label>Hora nativa <input id="native-time" type="time" min="08:00" max="18:00" step="900"></label>
    <label>Semana nativa <input id="native-week" type="week"></label>
    <label>Data bloqueada <input type="date" disabled></label>
    <label>Data somente leitura <input type="date" readonly></label>
    <label>Data revertida <input id="reverted-date" type="date"></label>
    <label>Segredo sintético <input type="password" value="SYNTHETIC_PRIVATE_DATE_SECRET"></label>
  `,
})(DateControls);

bootstrapApplication(DateControls, { providers: [importProvidersFrom(NoopAnimationsModule)] })
  .then((application) => {
    application.injector.get(PrimeNGConfig).setTranslation({
      monthNames: [
        "Janeiro",
        "Fevereiro",
        "Março",
        "Abril",
        "Maio",
        "Junho",
        "Julho",
        "Agosto",
        "Setembro",
        "Outubro",
        "Novembro",
        "Dezembro",
      ],
      monthNamesShort: [
        "Jan",
        "Fev",
        "Mar",
        "Abr",
        "Mai",
        "Jun",
        "Jul",
        "Ago",
        "Set",
        "Out",
        "Nov",
        "Dez",
      ],
    });
    document.querySelector("#reverted-date").addEventListener("change", (event) => {
      event.target.value = "";
    });
    document.body.dataset.ready = "true";
  })
  .catch(() => {
    document.body.dataset.ready = "failed";
  });
