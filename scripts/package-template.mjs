import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
await mkdir('artifacts',{recursive:true});
for(const slug of ['henrys','henrys-blue']) {
 const source=`templates/${slug}.pkpasstemplate`,files={};
 for(const name of await readdir(source)) if(!name.startsWith('.')) files[`${slug}.pkpasstemplate/${name}`]=new Uint8Array(await readFile(`${source}/${name}`));
 await writeFile(`artifacts/${slug}.pkpasstemplate.zip`,zipSync(files));
 console.log(`Packaged artifacts/${slug}.pkpasstemplate.zip; editable bundle in templates/.`);
}
