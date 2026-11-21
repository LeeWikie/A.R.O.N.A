import{z}from'zod';
/** Every supplied source still passes the active run's ownership checks. */
export const acceptedSourceIds=z.array(z.string().uuid()).min(1);
