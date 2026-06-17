
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    const filterLoft = document.querySelector("#filterLoft");
    const filterOwner = document.querySelector("#filterOwner");
    const filterColor = document.querySelector("#filterColor");
    const filterSummary = document.querySelector("#filterSummary");
    let pigeons = [];
    let currentRingNo = null;
    let filters = { loft: "", owner: "", color: "" };
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function getUniqueValues(arr, key) {
      const values = new Set();
      arr.forEach(item => { if (item[key] && item[key].trim()) values.add(item[key].trim()); });
      return Array.from(values).sort();
    }
    function updateFilterOptions() {
      const lofts = getUniqueValues(pigeons, "loft");
      const owners = getUniqueValues(pigeons, "owner");
      const colors = getUniqueValues(pigeons, "color");
      const currentLoft = filterLoft.value;
      const currentOwner = filterOwner.value;
      const currentColor = filterColor.value;
      filterLoft.innerHTML = '<option value="">全部鸽舍</option>' + lofts.map(v => '<option value="'+v+'"'+(v===currentLoft?' selected':'')+'>'+v+'</option>').join("");
      filterOwner.innerHTML = '<option value="">全部鸽主</option>' + owners.map(v => '<option value="'+v+'"'+(v===currentOwner?' selected':'')+'>'+v+'</option>').join("");
      filterColor.innerHTML = '<option value="">全部羽色</option>' + colors.map(v => '<option value="'+v+'"'+(v===currentColor?' selected':'')+'>'+v+'</option>').join("");
    }
    function applyFilters() {
      return pigeons.filter(p => {
        if (filters.loft && p.loft !== filters.loft) return false;
        if (filters.owner && p.owner !== filters.owner) return false;
        if (filters.color && p.color !== filters.color) return false;
        return true;
      });
    }
    function updateFilterSummary(filtered) {
      const parts = [];
      if (filters.loft) parts.push("鸽舍：" + filters.loft);
      if (filters.owner) parts.push("鸽主：" + filters.owner);
      if (filters.color) parts.push("羽色：" + filters.color);
      const total = pigeons.length;
      if (parts.length === 0) {
        filterSummary.textContent = "共 " + total + " 只档案（未筛选）";
      } else {
        filterSummary.textContent = "筛选条件：" + parts.join(" | ") + "，共显示 " + filtered.length + " / " + total + " 只";
      }
    }
    function renderCards() {
      const filtered = applyFilters();
      updateFilterSummary(filtered);
      cards.innerHTML = filtered.map(p => {
        const vaccineSummary = p.vaccines.length ? p.vaccines.map(v => '<div class="vaccine-item"><b>'+v.date+'</b> '+v.name+(v.remark?'<br><span class="meta">'+v.remark+'</span>':'')+'</div>').join("") : '<div class="vaccine-empty">暂无接种记录</div>';
        return '<article class="card"><h3>'+p.ringNo+'</h3><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><div class="section"><b>疫苗接种</b><div class="vaccine-list">'+vaccineSummary+'</div><label>疫苗名称</label><input data-vname="'+p.ringNo+'" placeholder="如新城疫、鸽痘"><label>接种日期</label><input data-vdate="'+p.ringNo+'" type="date"><label>备注</label><input data-vremark="'+p.ringNo+'" placeholder="选填"><button data-vaccine="'+p.ringNo+'">保存疫苗记录</button></div><label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button data-transfer="'+p.ringNo+'">保存转让</button></article>';
      }).join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load();
      });
      document.querySelectorAll("[data-vaccine]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.vaccine;
        const name = document.querySelector('[data-vname="'+ringNo+'"]').value.trim();
        const date = document.querySelector('[data-vdate="'+ringNo+'"]').value;
        const remark = document.querySelector('[data-vremark="'+ringNo+'"]').value.trim();
        if (!name) { alert("请填写疫苗名称"); return; }
        if (!date) { alert("请选择接种日期"); return; }
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/vaccines', { method:'POST', body: JSON.stringify({ name, date, remark }) });
        await load();
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、配对计划、转让、疫苗和成绩。</p>'; return; }
      const p = data.pigeon;
      const vaccineHtml = p.vaccines.length ? p.vaccines.map(v => '<div class="vaccine-item"><b>'+v.date+'</b> '+v.name+(v.remark?'<br><span class="meta">备注：'+v.remark+'</span>':'')+'</div>').join("") : '<div class="vaccine-empty">暂无接种记录</div>';
      const childrenHtml = data.children.length ? data.children.map(c => '<span class="pill">'+c.ringNo+'</span>').join(" ") : '<span class="meta">暂无已登记子代</span>';
      const plansHtml = data.breedingPlans && data.breedingPlans.length ? data.breedingPlans.map(plan => {
        const partner = plan.fatherRing === p.ringNo ? plan.motherRing : plan.fatherRing;
        const role = plan.fatherRing === p.ringNo ? "父鸽" : "母鸽";
        return '<div class="plan-item"><div><b>'+partner+'</b> <span class="meta">（'+role+'）</span></div><div class="meta">计划日期：'+plan.planDate+'</div>'+(plan.remark ? '<div class="meta">目标：'+plan.remark+'</div>' : '')+'</div>';
      }).join("") : '<div class="vaccine-empty">暂无配对计划</div>';
      let raceResultsHtml = '';
      const raceResults = data.raceResults || [];
      if (raceResults.length > 0) {
        const grouped = {};
        raceResults.forEach(r => {
          if (!grouped[r.date]) grouped[r.date] = [];
          grouped[r.date].push(r);
        });
        const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
        raceResultsHtml = dates.map(date => {
          const rows = grouped[date].map(r => {
            const rankBadge = r.rank ? '<span class="rank-badge '+(r.rank <= 3 ? 'top' : '')+'">第'+r.rank+'名</span>' : '<span class="meta">未排名</span>';
            return '<div class="race-result-row" style="cursor:pointer;" data-view-event="'+r.eventId+'" title="点击查看赛事详情"><div><div class="race-name">'+r.eventName+'</div><div class="race-detail">距离 '+r.distance+'km · 归巢 '+r.returnTime+'</div></div><div style="display:flex; align-items:center; gap:8px;"><button class="btn-icon" data-event-link="'+r.eventId+'" title="查看赛事">→</button>'+rankBadge+'</div></div>';
          }).join("");
          return '<div class="race-date-group"><div class="race-date-label">'+date+'</div>'+rows+'</div>';
        }).join("");
      } else {
        raceResultsHtml = '<div class="race-result-empty">暂无赛事成绩</div>';
      }
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div class="section"><b>已登记子代</b><div class="children-list">'+childrenHtml+'</div></div><div class="section"><b>配对计划</b><div class="plan-list">'+plansHtml+'</div></div><div class="section"><b>赛事成绩</b>'+raceResultsHtml+'</div><div class="section"><b>疫苗接种记录</b><div class="vaccine-list">'+vaccineHtml+'</div></div><div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div>';
      detail.querySelectorAll("[data-view-event], [data-event-link]").forEach(el => {
        el.onclick = (e) => {
          e.stopPropagation();
          const eventId = el.dataset.viewEvent || el.dataset.eventLink;
          currentRaceEventId = eventId;
          raceModal.style.display = "block";
          loadRaceEvents();
          setTimeout(() => loadRaceDetail(eventId), 100);
        };
      });
    }
    async function load(){
      pigeons = await api("/api/pigeons");
      updateFilterOptions();
      renderCards();
      if (currentRingNo) {
        try {
          const data = await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation');
          renderRelation(data);
        } catch(e) {
          renderRelation(null);
          currentRingNo = null;
        }
      } else {
        renderRelation(null);
      }
    }
    document.querySelector("#searchBtn").onclick = async () => {
      currentRingNo = search.value.trim();
      if (!currentRingNo) { renderRelation(null); return; }
      try {
        renderRelation(await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation'));
      } catch(e) {
        renderRelation(null);
      }
    };
    document.querySelector("#reload").onclick = load;
    filterLoft.onchange = () => { filters.loft = filterLoft.value; renderCards(); };
    filterOwner.onchange = () => { filters.owner = filterOwner.value; renderCards(); };
    filterColor.onchange = () => { filters.color = filterColor.value; renderCards(); };
    document.querySelector("#resetFilter").onclick = () => {
      filters = { loft: "", owner: "", color: "" };
      filterLoft.value = "";
      filterOwner.value = "";
      filterColor.value = "";
      renderCards();
    };
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    const importModal = document.querySelector("#importModal");
    const csvInput = document.querySelector("#csvInput");
    const previewArea = document.querySelector("#previewArea");
    let previewData = null;
    document.querySelector("#importBtn").onclick = () => { importModal.style.display = "block"; previewData = null; previewArea.innerHTML = ""; };
    document.querySelector("#closeImport").onclick = () => { importModal.style.display = "none"; };
    document.querySelector("#clearBtn").onclick = () => { csvInput.value = ""; previewArea.innerHTML = ""; previewData = null; };
    const breedingModal = document.querySelector("#breedingModal");
    const breedingForm = document.querySelector("#breedingForm");
    const breedingPlanList = document.querySelector("#breedingPlanList");
    document.querySelector("#breedingBtn").onclick = () => { breedingModal.style.display = "block"; loadBreedingPlans(); };
    document.querySelector("#closeBreeding").onclick = () => { breedingModal.style.display = "none"; };
    async function loadBreedingPlans() {
      try {
        const plans = await api("/api/breeding-plans");
        renderBreedingPlans(plans);
      } catch(e) {
        breedingPlanList.innerHTML = '<div class="hint" style="color:var(--red);">加载失败：' + e.message + '</div>';
      }
    }
    function renderBreedingPlans(plans) {
      if (!plans || plans.length === 0) {
        breedingPlanList.innerHTML = '<div class="vaccine-empty">暂无配对计划</div>';
        return;
      }
      breedingPlanList.innerHTML = plans.map(plan => {
        return '<div class="plan-card"><h4>'+plan.fatherRing+' × '+plan.motherRing+'</h4><div class="plan-meta">计划日期：'+plan.planDate+'</div>'+(plan.remark ? '<div class="plan-meta">目标：'+plan.remark+'</div>' : '')+'<div class="plan-meta">创建日期：'+plan.createdAt+'</div><div class="plan-actions"><button class="secondary danger" data-del-plan="'+plan.id+'">删除</button></div></div>';
      }).join("");
      document.querySelectorAll("[data-del-plan]").forEach(btn => btn.onclick = async () => {
        if (!confirm("确定要删除这个配对计划吗？")) return;
        try {
          await api('/api/breeding-plans/'+encodeURIComponent(btn.dataset.delPlan), { method:'DELETE' });
          loadBreedingPlans();
          if (currentRingNo) {
            try {
              const data = await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation');
              renderRelation(data);
            } catch(e) {}
          }
        } catch(e) {
          alert("删除失败：" + e.message);
        }
      });
    }
    breedingForm.onsubmit = async event => {
      event.preventDefault();
      const formData = new FormData(breedingForm);
      const fatherRing = formData.get("fatherRing") || "";
      const motherRing = formData.get("motherRing") || "";
      const planDate = formData.get("planDate") || "";
      const remark = formData.get("remark") || "";
      try {
        await api("/api/breeding-plans", { method:"POST", body: JSON.stringify({ fatherRing, motherRing, planDate, remark }) });
        breedingForm.reset();
        loadBreedingPlans();
        if (currentRingNo) {
          try {
            const data = await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation');
            renderRelation(data);
          } catch(e) {}
        }
        alert("配对计划创建成功！");
      } catch(e) {
        alert("创建失败：" + e.message);
      }
    };
    const raceModal = document.querySelector("#raceModal");
    const raceForm = document.querySelector("#raceForm");
    const raceEventList = document.querySelector("#raceEventList");
    const raceDetailTitle = document.querySelector("#raceDetailTitle");
    const raceDetailEmpty = document.querySelector("#raceDetailEmpty");
    const raceDetailContent = document.querySelector("#raceDetailContent");
    const entryTableBody = document.querySelector("#entryTableBody");
    const resultTableBody = document.querySelector("#resultTableBody");
    let currentRaceEventId = null;
    let currentRaceEvent = null;
    let entryRows = [];
    let editingResultRingNo = null;
    document.querySelector("#raceBtn").onclick = () => { raceModal.style.display = "block"; loadRaceEvents(); };
    document.querySelector("#closeRace").onclick = () => {
      raceModal.style.display = "none";
      currentRaceEventId = null;
      currentRaceEvent = null;
      entryRows = [];
      editingResultRingNo = null;
    };
    async function loadRaceEvents() {
      try {
        const events = await api("/api/race-events");
        renderRaceEvents(events);
      } catch(e) {
        raceEventList.innerHTML = '<div class="hint" style="color:var(--red);">加载失败：' + e.message + '</div>';
      }
    }
    function renderRaceEvents(events) {
      if (!events || events.length === 0) {
        raceEventList.innerHTML = '<div class="empty-state">暂无赛事</div>';
        return;
      }
      const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date));
      raceEventList.innerHTML = sorted.map(event => {
        const active = event.id === currentRaceEventId ? ' style="border-color:var(--accent);background:#f0f5fa;"' : '';
        return '<div class="race-event-card"'+active+'><h4>'+event.name+'</h4><div class="race-meta">日期：'+event.date+' · 距离：'+event.distance+'km</div><div class="race-meta">已录入：'+event.results.length+'只</div><div class="race-actions"><button class="secondary" data-view-race="'+event.id+'">管理</button><button class="secondary danger" data-del-race="'+event.id+'">删除</button></div></div>';
      }).join("");
      document.querySelectorAll("[data-view-race]").forEach(btn => btn.onclick = () => {
        currentRaceEventId = btn.dataset.viewRace;
        loadRaceDetail(currentRaceEventId);
      });
      document.querySelectorAll("[data-del-race]").forEach(btn => btn.onclick = async () => {
        if (!confirm("确定要删除这个赛事吗？删除后所有相关成绩将一并移除。")) return;
        try {
          await api('/api/race-events/'+encodeURIComponent(btn.dataset.delRace), { method:'DELETE' });
          if (currentRaceEventId === btn.dataset.delRace) {
            currentRaceEventId = null;
            currentRaceEvent = null;
            raceDetailEmpty.style.display = "block";
            raceDetailContent.style.display = "none";
          }
          loadRaceEvents();
          refreshPigeonDetail();
        } catch(e) {
          alert("删除失败：" + e.message);
        }
      });
    }
    async function loadRaceDetail(eventId) {
      try {
        const event = await api('/api/race-events/'+encodeURIComponent(eventId));
        currentRaceEvent = event;
        raceDetailEmpty.style.display = "none";
        raceDetailContent.style.display = "block";
        raceDetailTitle.textContent = event.name + '（' + event.date + ' · ' + event.distance + 'km）';
        document.querySelector("#editEventName").value = event.name;
        document.querySelector("#editEventDate").value = event.date;
        document.querySelector("#editEventDistance").value = event.distance;
        document.querySelector("#raceEventEditForm").style.display = "none";
        document.querySelector("#editEventBtn").style.display = "inline-block";
        document.querySelector("#resultCount").textContent = event.results.length;
        renderResultList(event.results);
        renderEntryTable();
        document.querySelector("#entryFeedback").innerHTML = "";
        setActiveTab("entry");
        loadRaceEvents();
      } catch(e) {
        alert("加载失败：" + e.message);
      }
    }
    function refreshPigeonDetail() {
      if (currentRingNo) {
        (async () => {
          try {
            const data = await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation');
            renderRelation(data);
          } catch(e) {}
        })();
      }
    }
    function setActiveTab(tabName) {
      document.querySelectorAll(".race-tab").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.tab === tabName);
      });
      document.querySelectorAll(".race-tab-content").forEach(content => {
        content.classList.toggle("active", content.id === "tab-" + tabName);
      });
    }
    document.querySelectorAll(".race-tab").forEach(tab => {
      tab.onclick = () => setActiveTab(tab.dataset.tab);
    });
    document.querySelector("#editEventBtn").onclick = () => {
      document.querySelector("#raceEventEditForm").style.display = "block";
      document.querySelector("#editEventBtn").style.display = "none";
    };
    document.querySelector("#cancelEditEventBtn").onclick = () => {
      document.querySelector("#raceEventEditForm").style.display = "none";
      document.querySelector("#editEventBtn").style.display = "inline-block";
      if (currentRaceEvent) {
        document.querySelector("#editEventName").value = currentRaceEvent.name;
        document.querySelector("#editEventDate").value = currentRaceEvent.date;
        document.querySelector("#editEventDistance").value = currentRaceEvent.distance;
      }
    };
    document.querySelector("#saveEventBtn").onclick = async () => {
      if (!currentRaceEventId) return;
      const name = document.querySelector("#editEventName").value.trim();
      const date = document.querySelector("#editEventDate").value;
      const distance = Number(document.querySelector("#editEventDistance").value || 0);
      if (!name) { alert("请填写赛事名称"); return; }
      if (!date) { alert("请选择赛事日期"); return; }
      try {
        await api('/api/race-events/'+encodeURIComponent(currentRaceEventId), {
          method:'PUT',
          body: JSON.stringify({ name, date, distance })
        });
        loadRaceDetail(currentRaceEventId);
        alert("赛事信息已更新！");
      } catch(e) {
        alert("保存失败：" + e.message);
      }
    };
    function renderResultList(results) {
      const sorted = [...results].sort((a, b) => {
        if (a.rank && b.rank) return a.rank - b.rank;
        if (a.rank) return -1;
        if (b.rank) return 1;
        return a.returnTime.localeCompare(b.returnTime);
      });
      if (sorted.length === 0) {
        resultTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--muted);">暂无成绩记录</td></tr>';
        return;
      }
      resultTableBody.innerHTML = sorted.map((r, idx) => {
        const isEditing = editingResultRingNo === r.ringNo;
        if (isEditing) {
          return '<tr><td><input type="number" min="0" value="'+r.rank+'" id="editRank-'+r.ringNo+'" style="width:70px;"></td><td><input type="text" value="'+r.ringNo+'" id="editRing-'+r.ringNo+'" style="width:160px;"></td><td><input type="text" value="'+r.returnTime+'" id="editTime-'+r.ringNo+'" style="width:100px;"></td><td style="text-align:center;"><button class="btn-small" data-save-edit="'+r.ringNo+'">保存</button> <button class="btn-small secondary" data-cancel-edit="'+r.ringNo+'">取消</button></td></tr>';
        }
        const rankBadge = r.rank ? '<span class="rank-badge '+(r.rank <= 3 ? 'top' : '')+'">第'+r.rank+'名</span>' : '<span class="meta">未排名</span>';
        return '<tr><td>'+rankBadge+'</td><td><b>'+r.ringNo+'</b></td><td>'+(r.returnTime || "-")+'</td><td style="text-align:center;"><button class="btn-icon" data-edit-result="'+r.ringNo+'" title="编辑">✎</button> <button class="btn-icon danger" data-del-result="'+r.ringNo+'" title="删除">✕</button></td></tr>';
      }).join("");
      document.querySelectorAll("[data-edit-result]").forEach(btn => btn.onclick = () => {
        editingResultRingNo = btn.dataset.editResult;
        renderResultList(currentRaceEvent.results);
      });
      document.querySelectorAll("[data-cancel-edit]").forEach(btn => btn.onclick = () => {
        editingResultRingNo = null;
        renderResultList(currentRaceEvent.results);
      });
      document.querySelectorAll("[data-save-edit]").forEach(btn => btn.onclick = async () => {
        const oldRingNo = btn.dataset.saveEdit;
        const newRingNo = document.querySelector('#editRing-'+oldRingNo).value.trim();
        const returnTime = document.querySelector('#editTime-'+oldRingNo).value.trim();
        const rank = Number(document.querySelector('#editRank-'+oldRingNo).value || 0);
        if (!newRingNo) { alert("请填写足环号"); return; }
        try {
          await api('/api/race-events/'+encodeURIComponent(currentRaceEventId)+'/results/'+encodeURIComponent(oldRingNo), {
            method:'PUT',
            body: JSON.stringify({ ringNo: newRingNo, returnTime, rank })
          });
          editingResultRingNo = null;
          loadRaceDetail(currentRaceEventId);
          refreshPigeonDetail();
        } catch(e) {
          alert("保存失败：" + e.message);
        }
      });
      document.querySelectorAll("[data-del-result]").forEach(btn => btn.onclick = async () => {
        if (!confirm("确定要删除这条成绩吗？")) return;
        try {
          await api('/api/race-events/'+encodeURIComponent(currentRaceEventId)+'/results/'+encodeURIComponent(btn.dataset.delResult), { method:'DELETE' });
          loadRaceDetail(currentRaceEventId);
          refreshPigeonDetail();
        } catch(e) {
          alert("删除失败：" + e.message);
        }
      });
    }
    function renderEntryTable() {
      document.querySelector("#entryCount").textContent = entryRows.length;
      if (entryRows.length === 0) {
        entryTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--muted);">点击上方"添加行"开始录入</td></tr>';
        return;
      }
      entryTableBody.innerHTML = entryRows.map((row, idx) => {
        return '<tr><td><input type="number" min="0" data-entry-rank="'+idx+'" value="'+(row.rank || '')+'" placeholder="名次" style="width:70px;"></td><td><input type="text" data-entry-ring="'+idx+'" value="'+(row.ringNo || '')+'" placeholder="足环号" style="width:160px;"></td><td><input type="text" data-entry-time="'+idx+'" value="'+(row.returnTime || '')+'" placeholder="如 10:42" style="width:100px;"></td><td style="text-align:center;"><button class="btn-icon danger" data-remove-row="'+idx+'" title="删除">✕</button></td></tr>';
      }).join("");
      entryRows.forEach((row, idx) => {
        const rankInput = document.querySelector('[data-entry-rank="'+idx+'"]');
        const ringInput = document.querySelector('[data-entry-ring="'+idx+'"]');
        const timeInput = document.querySelector('[data-entry-time="'+idx+'"]');
        if (rankInput) rankInput.oninput = () => { entryRows[idx].rank = rankInput.value; };
        if (ringInput) ringInput.oninput = () => { entryRows[idx].ringNo = ringInput.value; };
        if (timeInput) timeInput.oninput = () => { entryRows[idx].returnTime = timeInput.value; };
      });
      document.querySelectorAll("[data-remove-row]").forEach(btn => btn.onclick = () => {
        const idx = parseInt(btn.dataset.removeRow);
        entryRows.splice(idx, 1);
        renderEntryTable();
      });
    }
    document.querySelector("#addRowBtn").onclick = () => {
      entryRows.push({ ringNo: "", returnTime: "", rank: 0 });
      renderEntryTable();
    };
    document.querySelector("#clearEntryBtn").onclick = () => {
      if (!confirm("确定清空录入表吗？")) return;
      entryRows = [];
      renderEntryTable();
      document.querySelector("#entryFeedback").innerHTML = "";
    };
    document.querySelector("#submitEntryBtn").onclick = async () => {
      if (!currentRaceEventId) return;
      const validRows = entryRows.filter(r => r.ringNo && r.ringNo.trim());
      if (validRows.length === 0) { alert("请至少录入一条有效成绩"); return; }
      const results = validRows.map(r => ({
        ringNo: r.ringNo.trim(),
        returnTime: r.returnTime || "",
        rank: Number(r.rank || 0)
      }));
      try {
        const res = await api('/api/race-events/'+encodeURIComponent(currentRaceEventId)+'/results', {
          method:'POST',
          body: JSON.stringify({ results, overwrite: false })
        });
        handleSubmitResult(res, results);
      } catch(e) {
        alert("提交失败：" + e.message);
      }
    };
    function handleSubmitResult(res, results) {
      if (res.duplicate) {
        const dupList = res.duplicates.map(d => '<div class="duplicate-item"><b>'+d.ringNo+'</b>（现有：归巢 '+(d.existing.returnTime||"-")+' 第'+d.existing.rank+'名）</div>').join("");
        document.querySelector("#entryFeedback").innerHTML = '<div class="duplicate-warn"><h4>⚠ 检测到重复录入</h4><div style="font-size:13px;margin-bottom:8px;">以下足环号在该赛事中已有成绩，是否覆盖？</div>'+dupList+'<div style="margin-top:10px;display:flex;gap:8px;"><button id="overwriteEntryBtn" style="background:var(--yellow);">覆盖已有成绩</button><button id="cancelOverwriteBtn" class="secondary">取消</button></div></div>';
        document.querySelector("#overwriteEntryBtn").onclick = async () => {
          try {
            const res2 = await api('/api/race-events/'+encodeURIComponent(currentRaceEventId)+'/results', {
              method:'POST',
              body: JSON.stringify({ results, overwrite: true })
            });
            showSubmitSuccess(res2);
          } catch(e2) {
            alert("覆盖失败：" + e2.message);
          }
        };
        document.querySelector("#cancelOverwriteBtn").onclick = () => {
          document.querySelector("#entryFeedback").innerHTML = "";
        };
        return;
      }
      showSubmitSuccess(res);
    }
    function showSubmitSuccess(res) {
      let msg = '提交成功！新增 ' + res.added + ' 只';
      if (res.updated > 0) msg += '，覆盖 ' + res.updated + ' 只';
      if (res.invalidRings && res.invalidRings.length > 0) msg += '，无效足环号：' + res.invalidRings.join('、');
      entryRows = [];
      document.querySelector("#entryFeedback").innerHTML = "";
      loadRaceDetail(currentRaceEventId);
      refreshPigeonDetail();
      alert(msg);
    }
    document.querySelector("#parseImportBtn").onclick = () => {
      const input = document.querySelector("#raceResultInput").value.trim();
      if (!input) { alert("请粘贴成绩数据"); return; }
      const LF = String.fromCharCode(10);
      const CR = String.fromCharCode(13);
      const lines = input.split(LF).map(s => s.endsWith(CR) ? s.slice(0, -1) : s).filter(l => l.trim());
      const parsed = [];
      for (const line of lines) {
        const parts = line.split(",").map(s => s.trim());
        if (parts.length >= 1 && parts[0]) {
          parsed.push({
            ringNo: parts[0],
            returnTime: parts[1] || "",
            rank: Number(parts[2] || 0)
          });
        }
      }
      if (parsed.length === 0) { alert("未解析到有效数据"); return; }
      entryRows = [...entryRows, ...parsed];
      renderEntryTable();
      setActiveTab("entry");
      alert('已解析 ' + parsed.length + ' 条数据到录入表');
    };
    document.querySelector("#clearImportBtn").onclick = () => {
      document.querySelector("#raceResultInput").value = "";
    };
    raceForm.onsubmit = async event => {
      event.preventDefault();
      const formData = new FormData(raceForm);
      const name = formData.get("name") || "";
      const date = formData.get("date") || "";
      const distance = Number(formData.get("distance") || 0);
      if (!name.trim()) { alert("请填写赛事名称"); return; }
      if (!date) { alert("请选择赛事日期"); return; }
      try {
        const newEvent = await api("/api/race-events", { method:"POST", body: JSON.stringify({ name, date, distance }) });
        raceForm.reset();
        loadRaceEvents();
        currentRaceEventId = newEvent.id;
        loadRaceDetail(newEvent.id);
        alert("赛事创建成功！");
      } catch(e) {
        alert("创建失败：" + e.message);
      }
    };
    function renderPreview(data) {
      if (!data || !data.rows || data.rows.length === 0) {
        previewArea.innerHTML = '<div class="hint" style="margin-top:12px;">未解析到任何数据行，请检查CSV格式。</div>';
        return;
      }
      previewData = data;
      const statsHtml = '<div class="import-stats">' +
        '<div class="stat"><div class="num">' + data.total + '</div><div class="lbl">总行数</div></div>' +
        '<div class="stat good"><div class="num">' + data.valid + '</div><div class="lbl">有效记录</div></div>' +
        '<div class="stat bad"><div class="num">' + data.invalid + '</div><div class="lbl">无效记录</div></div>' +
        '<div class="stat warn"><div class="num">' + data.duplicates + '</div><div class="lbl">重复足环</div></div>' +
        '</div>';
      const tableRows = data.rows.map(function(r) {
        const cls = r._valid ? "" : "invalid";
        const status = r._valid ? '<span style="color:var(--green);font-weight:700;">✓ 有效</span>' : r._errors.map(function(e){ return '<span class="error-tag">' + e + '</span>'; }).join("");
        return '<tr class="' + cls + '">' +
          '<td>' + r._line + '</td>' +
          '<td>' + (r.ringNo || "") + '</td>' +
          '<td>' + (r.owner || "") + '</td>' +
          '<td>' + (r.fatherRing || "") + '</td>' +
          '<td>' + (r.motherRing || "") + '</td>' +
          '<td>' + (r.color || "") + '</td>' +
          '<td>' + (r.loft || "") + '</td>' +
          '<td>' + status + '</td>' +
        '</tr>';
      }).join("");
      const tableHtml = '<div class="table-wrap"><table class="preview-table"><thead><tr>' +
        '<th style="width:50px;">行号</th>' +
        '<th>足环号</th>' +
        '<th>鸽主</th>' +
        '<th>父环号</th>' +
        '<th>母环号</th>' +
        '<th>羽色</th>' +
        '<th>棚号</th>' +
        '<th>状态</th>' +
        '</tr></thead><tbody>' + tableRows + '</tbody></table></div>';
      const hintText = data.valid > 0 ? '将导入 <b style="color:var(--green);">' + data.valid + '</b> 条有效记录' : '无有效记录可导入';
      const btnDisabled = data.valid === 0 ? 'disabled' : '';
      const actionsHtml = '<div class="modal-actions">' +
        '<div class="hint">' + hintText + '</div>' +
        '<div style="display:flex; gap:8px;">' +
        '<button id="cancelImportBtn" class="secondary">取消</button>' +
        '<button id="commitImportBtn" ' + btnDisabled + '>确认导入（' + data.valid + '）</button>' +
        '</div></div>';
      previewArea.innerHTML = statsHtml + tableHtml + actionsHtml;
      document.querySelector("#cancelImportBtn").onclick = function() { importModal.style.display = "none"; };
      if (data.valid > 0) {
        document.querySelector("#commitImportBtn").onclick = doCommit;
      }
    }
    async function doCommit() {
      if (!previewData) return;
      const btn = document.querySelector("#commitImportBtn");
      btn.disabled = true;
      btn.textContent = "导入中...";
      try {
        const result = await api("/api/pigeons/import/commit", { method:"POST", body: JSON.stringify({ csv: csvInput.value }) });
        renderResult(result);
      } catch(e) {
        alert("导入失败：" + e.message);
        btn.disabled = false;
        btn.textContent = "确认导入（" + previewData.valid + "）";
      }
    }
    function renderResult(result) {
      let successHtml = "";
      if (result.successRows && result.successRows.length > 0) {
        const items = result.successRows.slice(0, 30).map(function(r) { return '<div class="success-item">第' + r.line + '行 · ' + r.ringNo + '</div>'; }).join("");
        const more = result.successRows.length > 30 ? '<div class="hint" style="margin-top:6px;">... 还有 ' + (result.successRows.length - 30) + ' 条成功记录</div>' : "";
        successHtml = '<h3 style="color:var(--green);">✓ 成功导入 ' + result.success + ' 条</h3><div class="success-list">' + items + '</div>' + more;
      }
      let failedHtml = "";
      if (result.failedRows && result.failedRows.length > 0) {
        const items = result.failedRows.map(function(r) { return '<div class="failed-item"><b>第' + r.line + '行</b> · ' + r.ringNo + '：' + r.errors.join("、") + '</div>'; }).join("");
        failedHtml = '<h3 style="color:var(--red); margin-top:12px;">✗ 失败 ' + result.failed + ' 条</h3><div class="failed-list">' + items + '</div>';
      }
      previewArea.innerHTML = '<div class="import-stats">' +
        '<div class="stat good"><div class="num">' + result.success + '</div><div class="lbl">导入成功</div></div>' +
        '<div class="stat bad"><div class="num">' + result.failed + '</div><div class="lbl">导入失败</div></div>' +
        '</div><div class="result-summary">' + successHtml + failedHtml + '</div>' +
        '<div class="modal-actions">' +
        '<div class="hint">导入完成，点击关闭返回。</div>' +
        '<button id="closeDoneBtn">关闭</button>' +
        '</div>';
      document.querySelector("#closeDoneBtn").onclick = function() {
        importModal.style.display = "none";
        load();
      };
    }
    document.querySelector("#previewBtn").onclick = async function() {
      if (!csvInput.value.trim()) {
        previewArea.innerHTML = '<div class="hint" style="margin-top:12px;">请先粘贴CSV文本。</div>';
        return;
      }
      try {
        const data = await api("/api/pigeons/import/preview", { method:"POST", body: JSON.stringify({ csv: csvInput.value }) });
        renderPreview(data);
      } catch(e) {
        previewArea.innerHTML = '<div class="hint" style="color:var(--red); margin-top:12px;">预览失败：' + e.message + '</div>';
      }
    };
    const pedigreeModal = document.querySelector("#pedigreeModal");
    const pedigreeSearch = document.querySelector("#pedigreeSearch");
    const pedigreeSearchBtn = document.querySelector("#pedigreeSearchBtn");
    const pedigreeContent = document.querySelector("#pedigreeContent");
    const pedigreeBreadcrumb = document.querySelector("#pedigreeBreadcrumb");
    let pedigreeHistory = [];
    let currentPedigreeRing = null;
    document.querySelector("#pedigreeBtn").onclick = () => {
      pedigreeModal.style.display = "block";
      if (currentRingNo) {
        pedigreeSearch.value = currentRingNo;
        loadPedigree(currentRingNo);
      }
    };
    document.querySelector("#closePedigree").onclick = () => { pedigreeModal.style.display = "none"; };
    pedigreeSearchBtn.onclick = () => {
      const ringNo = pedigreeSearch.value.trim();
      if (!ringNo) return;
      pedigreeHistory = [];
      loadPedigree(ringNo);
    };
    pedigreeSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") pedigreeSearchBtn.click();
    });
    function getBadgeLabel(generation, role) {
      if (generation === 0) return "本鸽";
      if (generation === -1) return "子代";
      if (generation === 1) {
        return role === "father" ? "父" : "母";
      }
      if (generation === 2) {
        return role || "祖辈";
      }
      return "";
    }
    function renderPedigreeNode(node, role, typeClass) {
      if (!node) return "";
      const isMissing = !node.exists && !node.circular;
      const isCircular = node.circular;
      let classes = "pedigree-node " + (typeClass || "");
      if (isMissing) classes += " missing";
      if (isCircular) classes += " circular";
      const badge = getBadgeLabel(node.generation, role);
      const displayRing = isMissing ? "未登记" : (isCircular ? (node.ringNo + " (循环)") : node.ringNo);
      let meta = "";
      if (!isMissing && !isCircular && node.pigeon) {
        const parts = [];
        if (node.pigeon.owner) parts.push(node.pigeon.owner);
        if (node.pigeon.color) parts.push(node.pigeon.color);
        if (parts.length) meta = '<div class="p-meta">' + parts.join(" · ") + '</div>';
      }
      if (isCircular) {
        meta = '<div class="p-meta">已在上层出现</div>';
      }
      const clickable = !isMissing && !isCircular;
      const clickAttr = clickable ? 'data-pedigree-jump="' + node.ringNo + '"' : '';
      const badgeHtml = badge ? '<span class="p-badge">' + badge + '</span>' : '';
      return '<div class="' + classes + '" ' + clickAttr + ' style="text-align:center;">' + badgeHtml + '<div class="p-ring">' + displayRing + '</div>' + meta + '</div>';
    }
    function renderGrandparentPair(fatherNode, motherNode, sideLabel) {
      const fatherRole = sideLabel === "paternal" ? "祖父" : "外祖父";
      const motherRole = sideLabel === "paternal" ? "祖母" : "外祖母";
      return '<div class="grandparent-col"><div class="generation-label">' + (sideLabel === "paternal" ? "父方祖辈" : "母方祖辈") + '</div><div class="grandparent-inner">' + renderPedigreeNode(fatherNode, fatherRole, "father") + renderPedigreeNode(motherNode, motherRole, "mother") + '</div></div>';
    }
    function renderPedigreeTree(tree) {
      const self = tree.self;
      const father = self.father || { ringNo: "", exists: false, circular: false, generation: 1, pigeon: null, father: null, mother: null };
      const mother = self.mother || { ringNo: "", exists: false, circular: false, generation: 1, pigeon: null, father: null, mother: null };
      const paternalGF = father.father || { ringNo: "", exists: false, circular: false, generation: 2, pigeon: null, father: null, mother: null };
      const paternalGM = father.mother || { ringNo: "", exists: false, circular: false, generation: 2, pigeon: null, father: null, mother: null };
      const maternalGF = mother.father || { ringNo: "", exists: false, circular: false, generation: 2, pigeon: null, father: null, mother: null };
      const maternalGM = mother.mother || { ringNo: "", exists: false, circular: false, generation: 2, pigeon: null, father: null, mother: null };
      let html = '<div class="pedigree-container">';
      html += '<div class="pedigree-legend"><div class="pedigree-legend-item"><div class="legend-dot self"></div><span>本鸽</span></div><div class="pedigree-legend-item"><div class="legend-dot father"></div><span>父系</span></div><div class="pedigree-legend-item"><div class="legend-dot mother"></div><span>母系</span></div><div class="pedigree-legend-item"><div class="legend-dot child"></div><span>子代</span></div><div class="pedigree-legend-item"><div class="legend-dot missing"></div><span>未登记</span></div><div class="pedigree-legend-item"><div class="legend-dot circular"></div><span>循环引用</span></div></div>';
      html += '<div class="tree-center">';
      html += '<div class="grandparents-row">' + renderGrandparentPair(paternalGF, paternalGM, "paternal") + renderGrandparentPair(maternalGF, maternalGM, "maternal") + '</div>';
      html += '<div class="connector-v" style="height:24px;"></div>';
      html += '<div class="parents-row">' + renderPedigreeNode(father, "父", "father") + renderPedigreeNode(mother, "母", "mother") + '</div>';
      html += '<div class="connector-v" style="height:24px;"></div>';
      html += '<div class="generation-row">' + renderPedigreeNode(self, "本鸽", "self") + '</div>';
      html += '</div>';
      if (tree.children && tree.children.length > 0) {
        html += '<div class="children-section"><div class="children-title">子代（共 ' + tree.children.length + ' 只）</div><div class="children-row">' + tree.children.map(child => renderPedigreeNode(child, "子代", "child")).join("") + '</div></div>';
      } else {
        html += '<div class="children-section"><div class="children-title">子代</div><div style="text-align:center;"><div class="pedigree-node missing" style="text-align:center;"><span class="p-badge">子代</span><div class="p-ring">未登记</div></div></div></div>';
      }
      html += '</div>';
      return html;
    }
    function renderPedigreeBreadcrumb() {
      if (pedigreeHistory.length === 0) { pedigreeBreadcrumb.innerHTML = ""; return; }
      let html = '<div class="pedigree-breadcrumb"><span style="font-size:12px;color:var(--muted);font-weight:700;">查询路径：</span>';
      pedigreeHistory.forEach((ring, idx) => {
        const isCurrent = idx === pedigreeHistory.length - 1;
        if (idx > 0) html += '<span class="crumb-sep">›</span>';
        html += '<span class="crumb ' + (isCurrent ? "current" : "") + '" ' + (isCurrent ? '' : 'data-crumb-jump="' + idx + '"') + '>' + ring + '</span>';
      });
      html += '</div>';
      pedigreeBreadcrumb.innerHTML = html;
      pedigreeBreadcrumb.querySelectorAll("[data-crumb-jump]").forEach(el => {
        el.onclick = () => {
          const idx = parseInt(el.dataset.crumbJump);
          pedigreeHistory = pedigreeHistory.slice(0, idx + 1);
          currentPedigreeRing = pedigreeHistory[idx];
          loadPedigreeData(currentPedigreeRing);
        };
      });
    }
    async function loadPedigree(ringNo) {
      currentPedigreeRing = ringNo;
      if (pedigreeHistory[pedigreeHistory.length - 1] !== ringNo) {
        pedigreeHistory.push(ringNo);
      }
      await loadPedigreeData(ringNo);
    }
    async function loadPedigreeData(ringNo) {
      try {
        const tree = await api('/api/pigeons/' + encodeURIComponent(ringNo) + '/pedigree');
        pedigreeContent.innerHTML = renderPedigreeTree(tree);
        renderPedigreeBreadcrumb();
        pedigreeContent.querySelectorAll("[data-pedigree-jump]").forEach(el => {
          el.onclick = () => loadPedigree(el.dataset.pedigreeJump);
        });
      } catch(e) {
        pedigreeContent.innerHTML = '<div class="empty-state" style="margin-top:20px;">未找到足环号 <b>' + ringNo + '</b> 的档案，请先在系统中登记。</div>';
        pedigreeBreadcrumb.innerHTML = "";
      }
    }
    load();
  