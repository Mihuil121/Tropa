// «Лёгкий режим» (слабый телефон) для компонентов, у которых нет доступа к настройкам.
let lite = false;
export const setLiteFlag = (v: boolean) => { lite = v; };
export const getLite = () => lite;
