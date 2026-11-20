const {authOk}=require('../lib/admin-auth');
const {json,clean,db,config,remotes}=require('../lib/game');
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value||'');
function validTime(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=Date.now()+5000;}
function mutationAllowed(req){
  if(req.headers['x-pin-to-win-admin']!=='1'||!String(req.headers['content-type']||'').startsWith('application/json'))return false;
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  try{return !req.headers.origin||new URL(req.headers.origin).host===req.headers.host;}catch{return false;}
}
const VISIBILITY={all:'',visible:'&hidden_at=is.null',hidden:'&hidden_at=not.is.null',review:'&hidden_at=not.is.null&review_reason=not.is.null'};
function median(values){if(!values.length)return null;const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;}
// Average error per destination, so staff can see which towns are too easy or too hard.
async function destinationStats(conf){
  const rows=[];
  for(let offset=0;offset<20000;offset+=1000){
    const page=await db(`pin_to_win_games?event_id=eq.${encodeURIComponent(conf.eventId)}&select=mission_ids,guesses&order=started_at.asc,id.asc&offset=${offset}&limit=1000`);
    rows.push(...(page||[]));if(!page||page.length<1000)break;
  }
  const by=new Map();
  for(const row of rows)(row.guesses||[]).forEach((g,i)=>{const id=row.mission_ids?.[i];if(!id||!Number.isFinite(g?.distanceKm))return;if(!by.has(id))by.set(id,[]);by.get(id).push(g);});
  return remotes.map(d=>{const list=by.get(d.id)||[],km=list.map(g=>g.distanceKm);return {id:d.id,name:d.name,state:d.state,difficulty:d.difficulty,plays:list.length,medianKm:median(km),meanKm:km.length?km.reduce((a,b)=>a+b,0)/km.length:null,within100:km.length?km.filter(k=>k<=100).length/km.length:null,hintRate:list.length?list.filter(g=>g.hint).length/list.length:null};})
    .sort((a,b)=>(b.plays?1:0)-(a.plays?1:0)||(b.medianKm??0)-(a.medianKm??0));
}
module.exports=async(req,res)=>{
  if(!authOk(req))return json(res,401,{ok:false,error:'Please sign in as an admin.'});
  const action=clean(req.query?.action||'list',20),conf=config();
  try{
    if(req.method==='GET'){
      if(action==='session')return json(res,200,{ok:true,...conf});
      if(action==='board')return json(res,200,{ok:true,rows:await db('rpc/pin_to_win_all_time_board',{method:'POST',body:{event_key:conf.eventId}}),...conf});
      if(action==='stats')return json(res,200,{ok:true,rows:await destinationStats(conf),...conf});
      if(action!=='list')return json(res,400,{ok:false,error:'Unknown action.'});
      const day=clean(req.query?.day,10),visibility=clean(req.query?.visibility||'all',10);
      const offset=Number(req.query?.offset||0),asOf=req.query?.asOf||new Date().toISOString();
      if((day&&!/^\d{4}-\d{2}-\d{2}$/.test(day))||!(visibility in VISIBILITY)||!Number.isSafeInteger(offset)||offset<0||!validTime(asOf))return json(res,400,{ok:false,error:'Invalid score filters.'});
      const filter=(day?'&event_day=eq.'+day:'')+VISIBILITY[visibility];
      const rows=await db(`pin_to_win_games?event_id=eq.${encodeURIComponent(conf.eventId)}${filter}&started_at=lte.${encodeURIComponent(asOf)}&select=id,full_name,email,organisation,score,total_distance,completed,source,started_at,event_day,hidden_at,review_reason&order=started_at.desc,id.desc&offset=${offset}&limit=101`);
      return json(res,200,{ok:true,rows:rows.slice(0,100),hasMore:rows.length>100,offset,asOf,...conf});
    }
    if(req.method!=='POST'){res.setHeader('Allow','GET, POST');return json(res,405,{ok:false,error:'Method not allowed.'});}
    if(!mutationAllowed(req))return json(res,403,{ok:false,error:'Please use the admin dashboard to change scores.'});
    let body;try{body=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch{}
    if(!body||!['hide','restore','clear'].includes(action))return json(res,400,{ok:false,error:'Invalid moderation request.'});
    let filter;
    if(action==='clear'){
      if(body.confirm!=='CLEAR LEADERBOARD'||!validTime(body.asOf))return json(res,400,{ok:false,error:'Type CLEAR LEADERBOARD to confirm.'});
      // Only completed games saved before the preview are archived. New/in-progress games continue normally.
      filter=`completed=eq.true&hidden_at=is.null&updated_at=lte.${encodeURIComponent(body.asOf)}`;
    }else{
      if(!uuid(body.id))return json(res,400,{ok:false,error:'Choose a valid score.'});
      filter=`id=eq.${body.id}`;
    }
    // Restoring a game that was held for review approves it. The review reason is kept as an audit note.
    const hiddenAt=action==='restore'?null:new Date().toISOString();
    await db(`pin_to_win_games?event_id=eq.${encodeURIComponent(conf.eventId)}&${filter}`,{method:'PATCH',prefer:'return=minimal',body:{hidden_at:hiddenAt}});
    return json(res,200,{ok:true,hiddenAt});
  }catch(error){console.error('Admin scores request failed:',error.code||error.name);return json(res,503,{ok:false,error:'Could not update or load cloud scores. Please try again.'});}
};
