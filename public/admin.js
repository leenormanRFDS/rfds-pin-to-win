'use strict';
const $=id=>document.getElementById(id),ROUNDS_KEY='rfds_pin_to_win_rounds_v2';
let conf={},boardRows=[],gameRows=[],eoiRows=[],statRows=[],offset=0,asOf='',boardAsOf='',pageRequest=0,busy=false;
const read=(key,fallback=[])=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const date=value=>value?new Date(value).toLocaleString('en-AU',{timeZone:conf.timezone||'Australia/Adelaide'}):'';
const REVIEW_REASONS={'fast':'Pins arrived faster than a person can play','near-perfect':'All three pins within a few kilometres','offline-high-score':'Very high score played offline'};
const reviewLabel=reason=>REVIEW_REASONS[reason]||reason||'';
function notice(message){$('adminStatus').textContent=message;}
function loginView(message=''){pageRequest++;$('app').hidden=true;$('loginView').hidden=false;$('loginError').textContent=message;boardRows=[];gameRows=[];eoiRows=[];statRows=[];for(const id of ['boardTable','scoresTable','eoiTable'])$(id).replaceChildren();$('statsTable').innerHTML='<p class="empty">Load statistics to see the table.</p>';$('statsCsv').disabled=true;$('reviewBanner').hidden=true;if($('clearDialog').open)$('clearDialog').close();}
async function request(action,{method='GET',body,query={}}={}){
 const params=new URLSearchParams({action,...query}),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
 try{const res=await fetch('/api/admin-scores?'+params,{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Pin-To-Win-Admin':'1'},body:body?JSON.stringify(body):undefined,signal:controller.signal});const result=await res.json().catch(()=>({}));if(res.status===401){loginView('Session expired. Please sign in again.');throw new Error('Please sign in again.');}if(!res.ok||!result.ok)throw new Error(result.error||'Cloud request failed. Try again.');return result;}finally{clearTimeout(timer);}
}
function table(head,body){return '<table><thead><tr>'+head.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+body+'</tbody></table>';}
async function loadBoard(){
 $('boardCsv').disabled=true;$('clearBoard').disabled=true;const snapshot=new Date().toISOString();
 try{const result=await request('board');if($('app').hidden)return;conf=result;boardAsOf=snapshot;boardRows=result.rows||[];$('boardCsv').disabled=!boardRows.length;$('clearBoard').disabled=!boardRows.length;
 $('boardTable').innerHTML=boardRows.length?table(['Rank','Name','Score','Total distance','Manage'],boardRows.map((r,i)=>'<tr><td>'+(i+1)+'</td><td class="name">'+escapeHtml(r.name)+'</td><td><strong>'+Number(r.score).toLocaleString()+'</strong></td><td>'+Number(r.total_distance||0).toFixed(1)+' km</td><td><button class="secondary" data-action="hide" data-id="'+escapeHtml(r.id)+'">Remove score</button></td></tr>').join('')):'<p class="empty">No high scores yet. New completed games will appear here.</p>';
 }catch(error){boardRows=[];$('boardTable').innerHTML='<p class="empty">'+escapeHtml(error.message)+'</p>';throw error;}
}
// Counts the first page of held scores so staff notice them without opening the filter.
async function loadReviewCount(){
 try{const result=await request('list',{query:{visibility:'review'}});if($('app').hidden)return;const n=result.rows.length,more=result.hasMore;$('reviewBanner').hidden=!n;$('reviewText').textContent=n?`${more?'More than 100':n} score${n===1&&!more?' is':'s are'} waiting for review before appearing on the leaderboard.`:'';}
 catch{$('reviewBanner').hidden=true;}
}
function filters(){return {day:$('scoreDay').value,visibility:$('visibility').value};}
function statusCell(r){
 let html=r.completed?'Complete':'In progress';
 if(r.hidden_at&&r.review_reason)html+='<small class="flag">Waiting for review: '+escapeHtml(reviewLabel(r.review_reason))+'</small>';
 else if(r.hidden_at)html+='<small>Removed from leaderboard</small>';
 else if(r.review_reason)html+='<small>Approved after review ('+escapeHtml(reviewLabel(r.review_reason))+')</small>';
 if(r.source==='offline')html+='<small>Recovered offline</small>';
 return html;
}
function manageCell(r){
 if(!r.completed)return '—';
 if(r.hidden_at)return '<button class="'+(r.review_reason?'primary':'secondary')+'" data-action="restore" data-id="'+escapeHtml(r.id)+'">'+(r.review_reason?'Approve score':'Restore score')+'</button>';
 return '<button class="secondary" data-action="hide" data-id="'+escapeHtml(r.id)+'">Remove score</button>';
}
async function loadGames(reset=false){
 if(reset){offset=0;asOf='';}const ticket=++pageRequest;$('scoresStatus').textContent='Loading game history…';$('prevPage').disabled=true;$('nextPage').disabled=true;gameRows=[];$('scoresTable').replaceChildren();
 try{const result=await request('list',{query:{...filters(),offset,...(asOf?{asOf}:{})}});if(ticket!==pageRequest||$('app').hidden)return;conf=result;asOf=result.asOf;gameRows=result.rows;$('pageLabel').textContent='Page '+(offset/100+1);$('prevPage').disabled=offset===0;$('nextPage').disabled=!result.hasMore;$('scoresStatus').textContent=`${gameRows.length} games on this page · Times shown in ${conf.timezone}`;
 $('scoresTable').innerHTML=gameRows.length?table(['Started','Name','Score','Status','Manage'],gameRows.map(r=>'<tr class="'+(r.hidden_at?(r.review_reason?'held':'removed'):'')+'"><td>'+escapeHtml(date(r.started_at))+'</td><td class="name">'+escapeHtml(r.full_name)+(r.organisation?'<small>'+escapeHtml(r.organisation)+'</small>':'')+'</td><td>'+Number(r.score).toLocaleString()+'</td><td>'+statusCell(r)+'</td><td>'+manageCell(r)+'</td></tr>').join('')):'<p class="empty">No games match these filters.</p>';
 }catch(error){if(ticket===pageRequest)$('scoresStatus').textContent=error.message;}
}
function updateDeviceBackup(action,id,hiddenAt){
 try{const records=read(ROUNDS_KEY);for(const r of records){if(r.eventId!==conf.eventId)continue;if(action==='clear'){if(r.completed&&r.synced&&(r.updatedAt||r.startedAt)<=boardAsOf)r.hiddenAt=hiddenAt;}else if(r.id===id){r.hiddenAt=hiddenAt;if(action==='restore')r.review=false;}}localStorage.setItem(ROUNDS_KEY,JSON.stringify(records));for(const key of ['rfds_pin_to_win_board_all_time_v1','rfds_pin_to_win_board_today_v1','rfds_pin_to_win_board_teams_v1'])localStorage.removeItem(key);}catch{notice('Cloud saved. This browser’s cached board could not be refreshed.');}
}
async function moderate(action,id){
 if(busy)return;busy=true;const buttons=[...document.querySelectorAll('[data-action]')];buttons.forEach(b=>b.disabled=true);
 const held=gameRows.find(r=>r.id===id)?.review_reason;
 try{const result=await request(action,{method:'POST',body:{id}});updateDeviceBackup(action,id,result.hiddenAt);notice(action==='restore'?(held?'Score approved and added to the leaderboard.':'Score restored.'):'Score removed. You can restore it in Game history.');await Promise.all([loadBoard(),loadGames(true),loadReviewCount()]);}catch(error){notice(error.message);}finally{busy=false;buttons.forEach(b=>b.disabled=false);}
}
function csvCell(value){let text=String(value??'');if(/^[\s]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';}
function downloadCsv(rows,name){const csv='﻿'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');download(new Blob([csv],{type:'text/csv;charset=utf-8'}),name);}
function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
$('loginForm').onsubmit=async e=>{e.preventDefault();$('loginBtn').disabled=true;$('loginError').textContent='';try{const res=await fetch('/api/eoi-admin?action=login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})});const data=await res.json();if(!res.ok||!data.ok)throw new Error(data.error||'Sign-in failed.');$('password').value='';await openDashboard();}catch(error){$('loginError').textContent=error.message;}finally{$('loginBtn').disabled=false;}};
async function openDashboard(){conf=await request('session');$('loginView').hidden=true;$('app').hidden=false;notice('');await Promise.allSettled([loadBoard(),loadGames(true),loadEois(),loadReviewCount()]);}
$('logoutBtn').onclick=async()=>{try{const res=await fetch('/api/eoi-admin?action=logout',{method:'POST',credentials:'same-origin'});if(!res.ok)throw new Error();loginView();$('password').focus();}catch{notice('Could not sign out. Please try again.');}};
$('refreshBoard').onclick=()=>Promise.all([loadBoard(),loadGames(true),loadReviewCount()]).catch(e=>notice(e.message));
$('showReview').onclick=()=>{$('scoreDay').value='';$('visibility').value='review';loadGames(true);$('gamesTitle').scrollIntoView({behavior:'smooth',block:'start'});};
$('filters').onsubmit=e=>{e.preventDefault();loadGames(true);};$('resetFilters').onclick=()=>{$('scoreDay').value='';$('visibility').value='all';loadGames(true);};$('prevPage').onclick=()=>{offset=Math.max(0,offset-100);loadGames();};$('nextPage').onclick=()=>{offset+=100;loadGames();};
for(const id of ['boardTable','scoresTable'])$(id).onclick=e=>{const b=e.target.closest('[data-action]');if(b)moderate(b.dataset.action,b.dataset.id);};
$('boardCsv').onclick=()=>downloadCsv([['Rank','Name','Score','Total distance km','Source'],...boardRows.map((r,i)=>[i+1,r.name,r.score,r.total_distance,r.source])],'PIN_TO_WIN_ALL_TIME_LEADERBOARD.csv');
$('gamesCsv').onclick=async()=>{const button=$('gamesCsv');button.disabled=true;const selected=filters();try{let all=[],position=0,snapshot;for(;;){const result=await request('list',{query:{...selected,offset:position,...(snapshot?{asOf:snapshot}:{})}});snapshot=result.asOf;all.push(...result.rows);notice(`Preparing download: ${all.length} games…`);if(!result.hasMore)break;position+=100;}
 downloadCsv([['Game ID','Name','Email','Organisation','Score','Total distance km','Completed','Source','Started','Conference date','Removed at','Review note'],...all.map(r=>[r.id,r.full_name,r.email||'',r.organisation||'',r.score,r.total_distance,r.completed,r.source,r.started_at,r.event_day,r.hidden_at||'',reviewLabel(r.review_reason)])],'PIN_TO_WIN_GAMES_'+(selected.day||'ALL_TIME')+'.csv');notice(`Downloaded ${all.length} game records.`);
 }catch(error){notice(error.message);}finally{button.disabled=false;}};
const pct=v=>v==null?'—':Math.round(v*100)+'%',km=v=>v==null?'—':Math.round(v).toLocaleString()+' km';
$('loadStats').onclick=async()=>{const button=$('loadStats');button.disabled=true;$('statsTable').innerHTML='<p class="empty">Loading…</p>';try{const result=await request('stats');statRows=result.rows||[];$('statsCsv').disabled=!statRows.length;
 const played=statRows.filter(r=>r.plays),unplayed=statRows.length-played.length;
 $('statsTable').innerHTML=(played.length?table(['Destination','Rated difficulty','Plays','Median error','Average error','Within 100 km','Hint use'],played.map(r=>'<tr><td class="name">'+escapeHtml(r.name)+'<small>'+escapeHtml(r.state)+'</small></td><td>'+r.difficulty+' / 5</td><td>'+r.plays.toLocaleString()+'</td><td><strong>'+km(r.medianKm)+'</strong></td><td>'+km(r.meanKm)+'</td><td>'+pct(r.within100)+'</td><td>'+pct(r.hintRate)+'</td></tr>').join('')):'<p class="empty">No completed flights yet.</p>')+(unplayed?'<p class="note inset">'+unplayed+' destination'+(unplayed===1?' has':'s have')+' not been played yet. The CSV lists every destination.</p>':'');
 }catch(error){$('statsTable').innerHTML='<p class="empty">'+escapeHtml(error.message)+'</p>';}finally{button.disabled=false;}};
$('statsCsv').onclick=()=>downloadCsv([['Destination ID','Destination','State','Rated difficulty','Plays','Median error km','Average error km','Share within 100 km','Hint use rate'],...statRows.map(r=>[r.id,r.name,r.state,r.difficulty,r.plays,r.medianKm==null?'':r.medianKm.toFixed(1),r.meanKm==null?'':r.meanKm.toFixed(1),r.within100??'',r.hintRate??''])],'PIN_TO_WIN_DESTINATION_DIFFICULTY.csv');
$('clearBoard').onclick=()=>{$('clearText').value='';$('clearError').textContent='';$('confirmClear').disabled=true;$('clearDialog').showModal();$('clearText').focus();};$('cancelClear').onclick=()=>$('clearDialog').close();$('clearText').oninput=()=>{$('confirmClear').disabled=$('clearText').value!=='CLEAR LEADERBOARD';};
$('clearForm').onsubmit=async e=>{e.preventDefault();if(busy||$('clearText').value!=='CLEAR LEADERBOARD')return;busy=true;$('confirmClear').disabled=true;$('cancelClear').disabled=true;try{const result=await request('clear',{method:'POST',body:{confirm:$('clearText').value,asOf:boardAsOf}});updateDeviceBackup('clear',null,result.hiddenAt);$('clearDialog').close();notice('Leaderboard cleared. Archived scores can be restored in Game history. New games can set fresh high scores.');await Promise.all([loadBoard(),loadGames(true)]);}catch(error){$('clearError').textContent=error.message;}finally{busy=false;$('cancelClear').disabled=false;$('confirmClear').disabled=$('clearText').value!=='CLEAR LEADERBOARD';}};
async function loadEois(){
 const local=read('rfds_pin_to_win_eois'),remote=[];let position=0;
 try{for(;;){const response=await fetch('/api/eoi-admin?action=list&offset='+position,{credentials:'same-origin',cache:'no-store'}),data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Could not load entries.');remote.push(...data.rows);if(!data.hasMore)break;position+=500;}if($('app').hidden)return;
 const map=new Map();for(const r of [...remote,...local]){const id=r.client_id||r.clientId||r.id||[r.submittedAt,r.fullName,r.email].join('|');if(!map.has(id))map.set(id,{submitted_at:r.submitted_at||r.submittedAt,full_name:r.full_name||r.fullName,email:r.email||'',organisation:r.organisation||'',consent:(r.contact_opt_in??r.contactOptIn)===true,source:r.id?'Server':'Device backup'});}
 eoiRows=[...map.values()];$('eoiCount').textContent=`${remote.length} server entries · ${local.length} device backup entries · ${eoiRows.filter(r=>r.consent).length} with recorded consent`;$('eoiCsv').disabled=!eoiRows.length;
 $('eoiTable').innerHTML=eoiRows.length?table(['Date','Name','Email','Organisation','Contact consent','Source'],eoiRows.map(r=>'<tr><td>'+escapeHtml(date(r.submitted_at))+'</td><td>'+escapeHtml(r.full_name)+'</td><td>'+escapeHtml(r.email||'Not provided')+'</td><td>'+escapeHtml(r.organisation||'—')+'</td><td>'+(r.consent?'<strong>Yes</strong>':'Not recorded')+'</td><td>'+r.source+'</td></tr>').join('')):'<p class="empty">No contact requests yet.</p>';
 }catch(error){$('eoiCount').textContent=error.message;}
}
$('eoiCsv').onclick=()=>downloadCsv([['Timestamp','Name','Email','Organisation','Contact consent','Record source'],...eoiRows.map(r=>[r.submitted_at,r.full_name,r.email,r.organisation,r.consent?'Yes':'Not recorded',r.source])],'PIN_TO_WIN_CONTACT_REQUESTS.csv');
$('deviceBackup').onclick=()=>download(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),rounds:read(ROUNDS_KEY),legacyBoard:read('rfds_demo_board'),entries:read('rfds_pin_to_win_eois')},null,2)],{type:'application/json'}),'PIN_TO_WIN_DEVICE_BACKUP.json');
(async()=>{try{await openDashboard();}catch{loginView();}})();
