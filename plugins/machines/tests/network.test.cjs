const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {execFileSync}=require('node:child_process');
test('SSH network rates use elapsed time and reject reset counters',()=>{
 const source=fs.readFileSync('backend/src/machines.rs','utf8');const expression=source.match(/rates=\$\(awk .*? '(BEGIN .*?)'\)/)[1];
 const rate=(r1,r2,s1,s2,n1,n2)=>execFileSync('awk',['-v',`r1=${r1}`,'-v',`r2=${r2}`,'-v',`s1=${s1}`,'-v',`s2=${s2}`,'-v',`n1=${n1}`,'-v',`n2=${n2}`,expression],{encoding:'utf8'});
 assert.deepEqual(JSON.parse('{"rx":'+rate(6000000000,6000004000,9000000000,9000002000,10,12)+'}'),{rx:2,tx:1});
 assert.deepEqual(JSON.parse('{"rx":'+rate(6000,1,100,200,10,12)+'}'),{rx:null,tx:null});
});
