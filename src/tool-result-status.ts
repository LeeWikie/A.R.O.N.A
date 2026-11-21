/** Explicit result flags belong to the tool contract, never to output prose. */
export function toolResultFailed(toolName:string,result:unknown):boolean {
  if(!result||typeof result!=='object'||Array.isArray(result))return false;
  const value=result as Record<string,unknown>;
  return value.error===true||((toolName==='web_fetch'||toolName==='web_search')&&value.isError===true);
}
