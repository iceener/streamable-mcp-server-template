import { confirmAction } from './confirm-action';
import { echo } from './echo';
import { getForecast } from './get-forecast';
import { whoami } from './whoami';

/** Every tool, in the order clients list them. Add yours here. */
export const tools = [getForecast, echo, whoami, confirmAction];
