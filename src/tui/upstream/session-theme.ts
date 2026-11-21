import { plainTheme, type Theme } from './theme.js';
export let theme: Theme = plainTheme;
export function setSessionTheme(value: Theme) { theme = value; }
