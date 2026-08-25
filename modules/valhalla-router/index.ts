import { requireOptionalNativeModule } from 'expo';

/**
 * Встроенный в телефон Valhalla (библиотека valhalla-mobile, MIT).
 * Маршруты и знаки скорости считаются прямо на телефоне по скачанному файлу дорог
 * (tar с тайлами Valhalla) — без интернета и без VPN.
 *
 * Запросы и ответы — обычный JSON Valhalla, тот же, что у сервера valhalla1.openstreetmap.de.
 */
type ValhallaRouterNative = {
  /** Поддерживает ли телефон (нужен Android 8+). */
  isSupported(): boolean;
  /** /route: tarPath — путь к файлу дорог области, request — JSON запроса. Ответ — JSON. */
  route(tarPath: string, request: string): Promise<string>;
  /** /trace_attributes — знаки скорости и классы дорог вдоль линии. */
  traceAttributes(tarPath: string, request: string): Promise<string>;
  /** Освободить память (файл дорог открыт через mmap). */
  close(): Promise<boolean>;
};

// Optional: в Expo Go / на iOS / в тестах модуля нет — тогда маршруты строятся как раньше.
const ValhallaRouter = requireOptionalNativeModule<ValhallaRouterNative>('ValhallaRouter');
export default ValhallaRouter;
