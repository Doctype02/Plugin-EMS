import { Azimuth } from 'building/iso';
import { ViewMode } from 'building/views';

export interface EmsOptions {
  demoMode: boolean;
  /** Obsoleto: el refresco lo decide la velocidad elegida en la barra de tiempo. */
  refreshSeconds?: number;
  /** Velocidad inicial de la simulación (veces el reloj real; 1 = hora real). */
  demoSpeed: number;
  /** Muestra la barra de tiempo (hora, día y velocidad de la simulación). */
  showTimeBar?: boolean;
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
  /**
   * Fotovoltaica en la azotea: 'auto' = en vivo si el medidor trae p_fv_kw, en demostración encendida;
   * 'on' / 'off' la fuerzan (variante del edificio con o sin FV).
   */
  pvMode?: 'auto' | 'on' | 'off';
  /** Control que simula el modo demostración: EMS por reglas con limitador o la línea base del modelo E+. */
  demoController?: 'reglas_dr' | 'baseline';
}
