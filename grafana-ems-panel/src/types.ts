import { Azimuth } from 'building/iso';
import { ViewMode } from 'building/views';

export interface EmsOptions {
  demoMode: boolean;
  refreshSeconds: number;
  /** Veces más rápido que el reloj real para el día simulado (1 = hora real). */
  demoSpeed: number;
  limitKw: number;
  defaultView: ViewMode;
  azimuth: Azimuth;
  exploded: boolean;
  showSummary: boolean;
  showSidebar: boolean;
  /** Permite enviar comandos (overrides y parámetros) desde el panel. */
  allowControl: boolean;
  /** Endpoint HTTP de Node-RED que recibe los comandos en modo en vivo. */
  controlUrl: string;
  animations: boolean;
}
