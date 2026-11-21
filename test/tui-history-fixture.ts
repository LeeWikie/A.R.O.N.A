import{TuiInputHistory}from'../src/tui/input-history.js';
const[directory,prefix]=process.argv.slice(2);if(!directory||!prefix)throw Error('fixture_arguments');const history=new TuiInputHistory(directory,'authenticated-core');for(let index=0;index<20;index++)history.append('store','main',`${prefix}-${index}`);
