const { Message, Result, Creds, State, Status, platforms, Audience, ValidationError, TriggerKind, PlainTrigger, MEDIA_MIME_ALL, Filter, Trigger, Content, Info, PLATFORMS_TITLES } = require('./send'),
    { DEFAULTS } = require('./send/data/const'),
    common = require('../../../api/utils/common'),
    log = common.log('push:api:message'),
    moment = require('moment-timezone');


/**
 * Validate data & construct message out of it, throw in case of error
 * 
 * @param {object} args plain object to construct Message from
 * @param {boolean} draft true if we need to skip checking data for validity
 * @returns {PostMessageOptions} Message instance in case validation passed, array of error messages otherwise
 * @throws {ValidationError} in case of error
 */
async function validate(args, draft = false) {
    let msg;
    if (draft) {
        let data = common.validateArgs(args, {
            _id: { required: false, type: 'ObjectID' },
            app: { required: true, type: 'ObjectID' },
            platforms: { required: true, type: 'String[]', in: () => require('./send/platforms').platforms },
            state: { type: 'Number' },
            status: { type: 'String', in: Object.values(Status) },
            filter: {
                type: Filter.scheme,
            },
            triggers: {
                type: Trigger.scheme,
                array: true,
                'min-length': 1
            },
            contents: {
                type: Content.scheme,
                array: true,
                nonempty: true,
                'min-length': 1,
            },
            info: {
                type: Info.scheme,
            }
        }, true);
        if (data.result) {
            msg = new Message(data.obj);
        }
        else {
            throw new ValidationError(data.errors);
        }
        msg.state = State.Inactive;
        msg.status = Status.Draft;
    }
    else {
        msg = Message.validate(args);
        if (msg.result) {
            msg = new Message(msg.obj);
        }
        else {
            throw new ValidationError(msg.errors);
        }
    }

    let app = await common.db.collection('apps').findOne(msg.app);
    if (app) {
        msg.info.appName = app.name;

        if (!args.demo && !(args.args && args.args.demo)) {
            for (let p of msg.platforms) {
                let id = common.dot(app, `plugins.push.${p}._id`);
                if (!id || id === 'demo') {
                    throw new ValidationError(`No push credentials for ${PLATFORMS_TITLES[p]} platform`);
                }
            }

            let creds = await common.db.collection(Creds.collection).find({_id: {$in: msg.platforms.map(p => common.dot(app, `plugins.push.${p}._id`))}}).toArray();
            if (creds.length !== msg.platforms.length) {
                throw new ValidationError('No push credentials in db');
            }
        }
    }
    else {
        throw new ValidationError('No such app');
    }

    if (msg.filter.geos.length) {
        let geos = await common.db.collection('geos').find({_id: {$in: msg.filter.geos.map(common.db.ObjectID)}}).toArray();
        if (geos.length !== msg.filter.geos.length) {
            throw new ValidationError('No such geo');
        }
    }

    if (msg.filter.cohorts.length) {
        let cohorts = await common.db.collection('cohorts').find({_id: {$in: msg.filter.cohorts}}).toArray();
        if (cohorts.length !== msg.filter.cohorts.length) {
            throw new ValidationError('No such cohort');
        }
    }

    if (msg._id) {
        let existing = await Message.findOne({_id: msg._id, state: {$bitsAllClear: State.Deleted}});
        if (!existing) {
            throw new ValidationError('No message with such _id');
        }

        if (existing.app.toString() !== msg.app.toString()) {
            throw new ValidationError('Message app cannot be changed');
        }

        if (existing.platforms.length !== msg.platforms.length || existing.platforms.filter(p => msg.platforms.indexOf(p) === -1).length) {
            throw new ValidationError('Message platforms cannot be changed');
        }

        // only 4 props of info can updated
        msg.info = new Info(Object.assign(existing.info.json, {
            title: msg.info.title,
            silent: msg.info.silent,
            scheduled: msg.info.scheduled,
            locales: msg.info.locales,
        }));

        // state & status cannot be changed by api
        msg.status = existing.status;
        msg.state = existing.state;
    }

    return msg;
}

module.exports.test = async params => {
    let msg = await validate(params.qstring),
        cfg = params.app.plugins && params.app.plugins.push || {},
        test_uids = cfg && cfg.test && cfg.test.uids ? cfg.test.uids.split(',') : undefined,
        test_cohorts = cfg && cfg.test && cfg.test.cohorts ? cfg.test.cohorts.split(',') : undefined,
        error;

    if (test_uids) {
        msg.filter = new Filter({user: JSON.stringify({uid: {$in: test_uids}})});
    }
    else if (test_cohorts) {
        msg.filter = new Filter({cohorts: test_cohorts});
    }
    else {
        throw new ValidationError('Please define test users in Push plugin configuration');
    }

    msg._id = common.db.ObjectID();
    msg.triggers = [new PlainTrigger({start: new Date()})];
    msg.state = State.Streamable;
    msg.status = Status.Scheduled;
    await msg.save();

    try {
        let audience = new Audience(log.sub('test-audience'), msg);
        await audience.getApp();

        let result = await audience.push(msg.triggerPlain()).setStart().run();
        if (result.total === 0) {
            throw new ValidationError('No users with push tokens found in test users');
        }
        else {
            await msg.update({$set: {result: result.json, test: true}}, () => msg.result = result);
        }

        let start = Date.now();
        while (start > 0) {
            // if ((Date.now() - start) > 5000) { // 5 seconds
            //     msg.result.processed = msg.result.total; // TODO: remove
            //     await msg.save();
            //     break;
            // }
            if ((Date.now() - start) > 90000) { // 1.5 minutes
                break;
            }
            msg = await Message.findOne(msg._id);
            if (!msg) {
                break;
            }
            if (msg.result.total === msg.result.processed) {
                break;
            }
            if (msg.is(State.Error)) {
                break;
            }

            await new Promise(res => setTimeout(res, 1000));
        }
    }
    catch (e) {
        error = e;
    }

    if (msg) {
        let ok = await msg.updateAtomically(
            {_id: msg._id, state: msg.state},
            {
                $bit: {state: {or: State.Deleted}},
                $set: {'result.removed': new Date(), 'result.removedBy': params.member._id, 'result.removedByName': params.member.full_name}
            });
        if (error) {
            log.e('Error while sending test message', error);
            common.returnMessage(params, 400, {errors: error.errors || [error.message || 'Unknown error']}, null, true);
        }
        else if (ok) {
            common.returnOutput(params, {result: msg.result.json});
        }
        else {
            common.returnMessage(params, 400, {errors: ['Message couldn\'t be deleted']}, null, true);
        }
    }
    else {
        common.returnMessage(params, 400, {errors: ['Failed to send test message']}, null, true);
    }
};

module.exports.create = async params => {
    let msg = await validate(params.qstring, params.qstring.status === Status.Draft),
        demo = params.qstring.demo === undefined ? params.qstring.args ? params.qstring.args.demo : false : params.qstring.demo;
    msg._id = common.db.ObjectID();
    msg.info.created = msg.info.updated = new Date();
    msg.info.createdBy = msg.info.updatedBy = params.member._id;
    msg.info.createdByName = msg.info.updatedByName = params.member.full_name;

    if (demo) {
        msg.info.demo = true;
    }

    if (params.qstring.status === Status.Draft) {
        msg.status = Status.Draft;
        msg.state = State.Inactive;
        await msg.save();
    }
    else {
        msg.state = State.Created;
        msg.status = Status.Created;
        await msg.save();
        if (!demo) {
            await msg.schedule(log, params);
        }
    }

    if (demo && demo !== 'no-data') {
        await generateDemoData(msg, demo);
    }

    common.returnOutput(params, msg.json);
};

module.exports.update = async params => {
    let msg = await validate(params.qstring, params.qstring.status === Status.Draft);
    msg.info.updated = new Date();
    msg.info.updatedBy = params.member._id;
    msg.info.updatedByName = params.member.full_name;

    if (msg.is(State.Done)) {
        if (msg.triggerAutoOrApi()) {
            msg.state = State.Created;
            msg.status = Status.Created;
            await msg.save();
            await msg.schedule(log, params);
        }
        else if (msg.triggerPlain()) {
            throw new ValidationError('Finished plain messages cannot be changed');
        }
        else {
            throw new ValidationError('Wrong trigger kind');
        }
    }
    else {
        msg.info.rejected = null;
        msg.info.rejectedAt = null;
        msg.info.rejectedBy = null;
        msg.info.rejectedByName = null;

        if (msg.status === Status.Draft && params.qstring.status === Status.Created) {
            msg.status = Status.Created;
            msg.state = State.Created;
            await msg.save();
            await msg.schedule(log, params);
        }
        else {
            await msg.save();
        }
    }


    common.returnOutput(params, msg.json);
};

module.exports.remove = async params => {
    let data = common.validateArgs(params.qstring, {
        _id: {type: 'ObjectID', required: true},
    }, true);

    if (!data.result) {
        common.returnMessage(params, 400, {errors: data.errors}, null, true);
        return true;
    }

    let msg = await Message.findOne({_id: data.obj._id, state: {$bitsAllClear: State.Deleted}});
    if (!msg) {
        common.returnMessage(params, 404, {errors: ['Message not found']}, null, true);
        return true;
    }

    // TODO: stop the sending via cache
    await msg.stop(log);

    let ok = await msg.updateAtomically(
        {_id: msg._id, state: msg.state},
        {
            $bit: {state: {or: State.Deleted}},
            $set: {'result.removed': new Date(), 'result.removedBy': params.member._id, 'result.removedByName': params.member.full_name}
        });
    if (ok) {
        common.returnOutput(params, {});
    }
    else {
        throw new ValidationError('Failed to delete the message, please try again');
    }
};


module.exports.toggle = async params => {
    let data = common.validateArgs(params.qstring, {
        _id: {type: 'ObjectID', required: true},
        active: {type: 'BooleanString', required: true}
    }, true);
    if (data.result) {
        data = data.obj;
    }
    else {
        common.returnMessage(params, 400, {errors: data.errors}, null, true);
        return true;
    }

    let msg = await Message.findOne(data._id);
    if (!msg) {
        common.returnMessage(params, 404, {errors: ['Message not found']}, null, true);
        return true;
    }

    if (!msg.triggerAutoOrApi()) {
        throw new ValidationError(`The message doesn't have Cohort or Event trigger`);
    }

    if (data.active && msg.is(State.Streamable)) {
        throw new ValidationError(`The message is already active`);
    }
    else if (!data.active && !msg.is(State.Streamable)) {
        throw new ValidationError(`The message is already stopped`);
    }

    if (msg.is(State.Streamable)) {
        await msg.stop(log);
    }
    else {
        await msg.schedule(log, params);
    }

    common.returnOutput(params, msg.json);
};


module.exports.estimate = async params => {
    let data = common.validateArgs(params.qstring, {
        app: {type: 'ObjectID', required: true},
        platforms: {type: 'String[]', required: true, in: () => platforms, 'min-length': 1},
        filter: {
            type: {
                user: {type: 'JSON'},
                drill: {type: 'JSON'},
                geos: {type: 'ObjectID[]'},
                cohorts: {type: 'String[]'},
            },
            required: false
        }
    }, true);

    if (data.result) {
        data = data.obj;
        if (!data.filter) {
            data.filter = {};
        }
        if (!data.filter.geos) {
            data.filter.geos = [];
        }
        if (!data.filter.cohorts) {
            data.filter.cohorts = [];
        }
    }
    else {
        common.returnMessage(params, 400, {errors: data.errors}, null, true);
        return true;
    }

    let app = await common.db.collection('apps').findOne({_id: data.app});
    if (!app) {
        common.returnMessage(params, 400, {errors: ['No such app']}, null, true);
        return true;
    }

    for (let p of data.platforms) {
        let id = common.dot(app, `plugins.push.${p}._id`);
        if (!id || id === 'demo') {
            throw new ValidationError(`No push credentials for ${PLATFORMS_TITLES[p]} platform `);
        }
    }

    let steps = await new Audience(log, new Message(data), app).steps({la: 1}),
        cnt = await common.db.collection(`app_users${data.app}`).aggregate(steps.concat([{$count: 'count'}])).toArray(),
        count = cnt[0] && cnt[0].count || 0,
        las = await common.db.collection(`app_users${data.app}`).aggregate(steps.concat([
            {$project: {_id: '$la'}},
            {$group: {_id: '$_id', count: {$sum: 1}}}
        ])).toArray(),
        locales = las.reduce((a, b) => {
            a[b._id || 'default'] = b.count;
            return a;
        }, {default: 0});

    common.returnOutput(params, {count, locales});
};

module.exports.mime = async params => {
    try {
        let info = await mimeInfo(params.qstring.url);
        if (info.status !== 200) {
            common.returnMessage(params, 400, {errors: [`Invalid status ${info.status}`]}, null, true);
        }
        else if (info.headers['content-type'] === undefined) {
            common.returnMessage(params, 400, {errors: ['No content-type while HEADing the url']}, null, true);
        }
        else if (info.headers['content-length'] === undefined) {
            info = await mimeInfo(params.qstring.url, 'GET');
            if (info.headers['content-length'] === undefined) {
                return common.returnMessage(params, 400, {errors: ['No content-length while HEADing the url']}, null, true);
            }
        }
        if (MEDIA_MIME_ALL.indexOf(info.headers['content-type']) === -1) {
            common.returnMessage(params, 400, {errors: [`Media mime type "${info.headers['content-type']}" is not supported`]}, null, true);
        }
        else if (parseInt(info.headers['content-length'], 10) > DEFAULTS.max_media_size) {
            common.returnMessage(params, 400, {errors: [`Media size (${info.headers['content-length']}) is too large`]}, null, true);
        }
        else {
            let media = info.url,
                mediaMime = info.headers['content-type'],
                mediaSize = parseInt(info.headers['content-length'], 10);

            common.returnOutput(params, {
                media,
                mediaMime,
                mediaSize
            });
        }
    }
    catch (err) {
        if (!err.errors) {
            log.e('Mime request error', err);
        }
        common.returnMessage(params, 400, {errors: err.errors || ['Server error']}, null, true);
    }
};

module.exports.one = async params => {
    let data = common.validateArgs(params.qstring, {
        _id: {type: 'ObjectID', required: true},
    }, true);
    if (data.result) {
        data = data.obj;
    }
    else {
        common.returnMessage(params, 400, {errors: data.errors}, null, true);
        return true;
    }

    let msg = await Message.findOne(data._id);
    if (!msg) {
        common.returnMessage(params, 404, {errors: ['Message not found']}, null, true);
        return true;
    }

    common.returnOutput(params, msg.json);
};

module.exports.all = async params => {
    let data = common.validateArgs(params.qstring, {
        app_id: {type: 'ObjectID', required: true},
        auto: {type: 'BooleanString', required: false},
        api: {type: 'BooleanString', required: false},
        sSearch: {type: 'RegExp', required: false, mods: 'gi'},
        iDisplayStart: {type: 'IntegerString', required: false},
        iDisplayLength: {type: 'IntegerString', required: false},
        iSortCol_0: {type: 'String', required: false},
        sSortDir_0: {type: 'String', required: false, in: ['asc', 'desc']},
        sEcho: {type: 'String', required: false},
    }, true);

    if (data.result) {
        data = data.obj;

        let query = {
            app: data.app_id,
            state: {$bitsAllClear: State.Deleted},
        };

        if (data.auto) {
            query['triggers.kind'] = {$in: [TriggerKind.Event, TriggerKind.Cohort]};
        }
        else if (data.api) {
            query['triggers.kind'] = TriggerKind.API;
        }
        else {
            query['triggers.kind'] = TriggerKind.Plain;
        }

        let total = await Message.count(query);

        if (data.sSearch) {
            query.$or = [
                {'contents.message': data.sSearch},
                {'contents.title': data.sSearch},
            ];
        }
        let cursor = common.db.collection(Message.collection).find(query),
            count = await cursor.count();

        if (data.iDisplayStart) {
            cursor.skip(data.iDisplayStart);
        }
        if (data.iDisplayLength) {
            cursor.limit(data.iDisplayLength);
        }
        if (data.iSortCol_0 && data.sSortDir_0) {
            cursor.sort({[data.iSortCol_0]: data.sSortDir_0 === 'asc' ? -1 : 1});
        }
        else {
            cursor.sort({'triggers.start': -1});
        }

        let items = await cursor.toArray();

        // mongo sort doesn't work for selected array elements
        if (!data.iSortCol_0 || data.iSortCol_0 === 'triggers.start') {
            items.sort((a, b) => {
                a = a.triggers.filter(t => {
                    if (data.auto) {
                        return [TriggerKind.Event, TriggerKind.Cohort].includes(t.kind);
                    }
                    else if (data.api) {
                        return t.kind === TriggerKind.API;
                    }
                    else {
                        return t.kind === TriggerKind.Plain;
                    }
                })[0];
                b = b.triggers.filter(t => {
                    if (data.auto) {
                        return [TriggerKind.Event, TriggerKind.Cohort].includes(t.kind);
                    }
                    else if (data.api) {
                        return t.kind === TriggerKind.API;
                    }
                    else {
                        return t.kind === TriggerKind.Plain;
                    }
                })[0];

                return new Date(b.start).getTime() - new Date(a.start).getTime();
            });
        }

        common.returnOutput(params, {
            sEcho: data.sEcho,
            iTotalRecords: total,
            iTotalDisplayRecords: count,
            aaData: items || []
        }, true);

    }
    else {
        common.returnMessage(params, 400, {errors: data.errors}, null, true);
        return true;
    }
};

/**
 * Generate demo data for populator
 * 
 * @param {Message} msg message instance
 * @param {int} demo demo type
 */
async function generateDemoData(msg, demo) {
    await common.db.collection('apps').updateOne({_id: msg.app, 'plugins.push.i._id': {$exists: false}}, {$set: {'plugins.push.i._id': 'demo'}});
    await common.db.collection('apps').updateOne({_id: msg.app, 'plugins.push.a._id': {$exists: false}}, {$set: {'plugins.push.a._id': 'demo'}});
    await common.db.collection('apps').updateOne({_id: msg.app, 'plugins.push.h._id': {$exists: false}}, {$set: {'plugins.push.h._id': 'demo'}});

    let app = await common.db.collection('apps').findOne({_id: msg.app}),
        count = await common.db.collection('app_users' + msg.app).find().count(),
        events = [],
        result = msg.result || new Result();

    if (msg.triggerAutoOrApi()) {
        msg.state = State.Created | State.Streamable;
        msg.status = Status.Scheduled;

        let total = Math.floor(count * 0.72),
            sent = Math.floor(total * 0.92),
            actioned = Math.floor(sent * 0.17),
            offset = moment.tz(app.timezone).utcOffset(),
            now = Date.now() - 3600000,
            a = !!msg.triggerAuto(),
            t = !a,
            p = msg.platforms[0],
            p1 = msg.platforms[1];

        for (let i = 0; i < 19; i++) {
            let date = now - (i + 1) * (24 * 3600000) - offset,
                es = Math.floor((Math.random() + 0.5) / (19 - i) * sent),
                ea = Math.floor((Math.random() + 0.5) / (19 - i) * actioned);

            ea = Math.min(ea, Math.floor(es * 0.5));

            sent -= es;
            actioned -= ea;

            if (es) {
                result.processed += es;
                result.total += es;
                result.sent += es;

                let es_p0 = Math.floor(es * 2 / 3),
                    es_p1 = es - es_p0;
                if (es_p0 && es_p1 && p1) {
                    result.sub(p).processed += es_p0;
                    result.sub(p).total += es_p0;
                    result.sub(p).sent += es_p0;
                    result.sub(p1).processed += es_p1;
                    result.sub(p1).total += es_p1;
                    result.sub(p1).sent += es_p1;
                    events.push({timestamp: date, key: '[CLY]_push_sent', count: es_p0, segmentation: {i: msg.id, a, t, p, ap: a + p, tp: t + p}});
                    events.push({timestamp: date, key: '[CLY]_push_sent', count: es_p1, segmentation: {i: msg.id, a, t, p: p1, ap: a + p1, tp: t + p1}});
                }
                else {
                    result.sub(p).processed += es;
                    result.sub(p).total += es;
                    result.sub(p).sent += es;
                    events.push({timestamp: date, key: '[CLY]_push_sent', count: es, segmentation: {i: msg.id, a, t, p, ap: a + p, tp: t + p}});
                }
            }
            if (ea) {
                let ea_p0 = Math.floor(ea * 2 / 3),
                    ea_p1 = ea - ea_p0;
                if (ea_p0 && ea_p1 && p1) {
                    result.sub(p).actioned += ea_p0;
                    result.sub(p1).actioned += ea_p1;
                    events.push({timestamp: date, key: '[CLY]_push_action', count: ea_p0, segmentation: {i: msg.id, b: 1, a, t, p, ap: a + p, tp: t + p}});
                    events.push({timestamp: date, key: '[CLY]_push_action', count: ea_p1, segmentation: {i: msg.id, b: 1, a, t, p: p1, ap: a + p1, tp: t + p1}});
                }
                else {
                    result.sub(p).actioned += ea;
                    events.push({timestamp: date, key: '[CLY]_push_action', count: ea, segmentation: {i: msg.id, b: 1, a, t, p, ap: a + p, tp: t + p}});
                }
            }
        }

        let st = Math.floor(sent / 3),
            at = Math.floor(actioned / 3);

        if (st) {
            result.processed += st;
            result.total += st;
            result.sent += st;
            result.sub(p).processed += st;
            result.sub(p).total += st;
            events.push({timestamp: now - 24 * 3600000 - offset, key: '[CLY]_push_sent', count: st, segmentation: {i: msg.id, a, t, p, ap: a + p, tp: t + p}});
        }
        if (at) {
            result.actioned += at;
            result.sub(p).actioned += at;
            events.push({timestamp: now - 24 * 3600000 - offset, key: '[CLY]_push_action', count: at, segmentation: {i: msg.id, a, t, p, ap: a + p, tp: t + p}});
        }

        sent = sent - st;
        actioned = actioned - at;

        result.processed += sent;
        result.total += sent;
        result.sent += sent;
        result.actioned += actioned;
        result.sub(p).processed += sent;
        result.sub(p).total += sent;
        result.sub(p).sent += sent;
        result.sub(p).actioned += actioned;
        events.push({timestamp: now - offset, key: '[CLY]_push_sent', count: sent, segmentation: {i: msg.id, a, t, p, ap: a + p, tp: t + p}});
        events.push({timestamp: now - offset, key: '[CLY]_push_action', count: actioned, segmentation: {i: msg.id, a, t, p, ap: a + p, tp: t + p}});
    }
    else {
        msg.state = State.Created | State.Done;
        msg.status = Status.Sent;

        let total = demo === 1 ? Math.floor(count * 0.92) : Math.floor(Math.floor(count * 0.92) * 0.87),
            sent = demo === 1 ? Math.floor(total * 0.87) : total,
            actioned = Math.floor(sent * (demo === 1 ? 0.38 : 0.21)),
            // actioned1 = Math.floor(actioned * (demo === 1 ? 0.76 : 0.64)),
            // actioned2 = Math.floor(actioned * (demo === 1 ? 0.21 : 0.37)),
            // actioned0 = actioned - actioned1 - actioned2,
            a = false,
            t = false,
            p = msg.platforms[0],
            p1 = msg.platforms[1];


        let s_p0 = Math.floor(sent / 3),
            a_p0 = Math.floor(actioned / 3),
            a0_p0 = Math.floor(a_p0 * 2 / 3),
            a1_p0 = Math.floor((a_p0 - a0_p0) * 2 / 3),
            a2_p0 = a_p0 - a0_p0 - a1_p0,
            s_p1 = sent - s_p0,
            a_p1 = actioned - a_p0,
            a0_p1 = Math.floor(a_p1 * 2 / 3),
            a1_p1 = Math.floor((a_p1 - a0_p1) * 2 / 3),
            a2_p1 = a_p1 - a0_p1 - a1_p1;

        log.d('msggggggg %s: sent %d, actioned %d (%d %d-%d-%d / %d %d-%d-%d)', msg.id, sent, actioned, a_p0, a0_p0, a1_p0, a2_p0, a_p1, a0_p1, a1_p1, a2_p1);

        result.processed += sent;
        result.total += sent;
        result.sent += sent;
        result.actioned += a0_p0 + a1_p0 + a2_p0 + a0_p1 + a1_p1 + a2_p1;
        result.sub(p).processed += s_p0;
        result.sub(p).total += s_p0;
        result.sub(p).sent += s_p0;
        result.sub(p).actioned += a0_p0 + a1_p0 + a2_p0;
        result.sub(msg.platforms[1]).processed += s_p1;
        result.sub(msg.platforms[1]).total += s_p1;
        result.sub(msg.platforms[1]).sent += s_p1;
        result.sub(msg.platforms[1]).actioned += a0_p1 + a1_p1 + a2_p1;

        if (s_p0) {
            events.push({key: '[CLY]_push_sent', count: s_p0, segmentation: {i: msg.id, a, t, p, ap: a + p, tp: t + p}});
        }
        if (a0_p0) {
            events.push({key: '[CLY]_push_action', count: a0_p0, segmentation: {i: msg.id, b: 0, a, t, p, ap: a + p, tp: t + p}});
        }
        if (a1_p0) {
            events.push({key: '[CLY]_push_action', count: a1_p0, segmentation: {i: msg.id, b: 1, a, t, p, ap: a + p, tp: t + p}});
        }
        if (a2_p0) {
            events.push({key: '[CLY]_push_action', count: a2_p0, segmentation: {i: msg.id, b: 2, a, t, p, ap: a + p, tp: t + p}});
        }
        if (s_p1) {
            events.push({key: '[CLY]_push_sent', count: s_p1, segmentation: {i: msg.id, a, t, p: p1, ap: a + p1, tp: t + p1}});
        }
        if (a0_p1) {
            events.push({key: '[CLY]_push_action', count: a0_p1, segmentation: {i: msg.id, b: 0, a, t, p: p1, ap: a + p1, tp: t + p1}});
        }
        if (a1_p1) {
            events.push({key: '[CLY]_push_action', count: a1_p1, segmentation: {i: msg.id, b: 1, a, t, p: p1, ap: a + p1, tp: t + p1}});
        }
        if (a2_p1) {
            events.push({key: '[CLY]_push_action', count: a2_p1, segmentation: {i: msg.id, b: 2, a, t, p: p1, ap: a + p1, tp: t + p1}});
        }
    }

    require('../../../api/parts/data/events').processEvents({
        qstring: {events},
        app_id: app._id.toString(),
        appTimezone: app.timezone,
        time: common.initTimeObj(app.timezone)
    });

    await msg.update({$set: {result: result.json, state: msg.state, status: msg.status}}, () => {
        msg.result = result;
    });
}

/** 
 * Get MIME of the file behind url by sending a HEAD request
 * 
 * @param {string} url - url to get info from
 * @param {string} method - http method to use
 * @returns {Promise} - {status, headers} in case of success, PushError otherwise
 */
function mimeInfo(url, method = 'HEAD') {
    let conf = common.plugins.getConfig('push'),
        ok = common.validateArgs({url}, {
            url: {type: 'URLString', required: true},
        }, true),
        protocol = 'http';

    if (ok.result) {
        url = ok.obj.url;
        protocol = url.protocol.substr(0, url.protocol.length - 1);
    }
    else {
        throw new ValidationError(ok.errors);
    }

    log.d('Retrieving URL', url);

    return new Promise((resolve, reject) => {
        if (conf && conf.proxyhost) {
            let opts = {
                host: conf.proxyhost,
                method: 'CONNECT',
                path: url.hostname + ':' + (url.port ? url.port : (protocol === 'https' ? 443 : 80)),
                rejectUnauthorized: !(conf.proxyunauthorized || false),
            };
            if (conf.proxyport) {
                opts.port = conf.proxyport;
            }
            if (conf.proxyuser) {
                opts.headers = {'Proxy-Authorization': 'Basic ' + Buffer.from(conf.proxyuser + ':' + conf.proxypass).toString('base64')};
            }
            log.d('Connecting to proxy', opts);

            require('http')
                .request(url, opts)
                .on('connect', (res, socket) => {
                    if (res.statusCode === 200) {
                        opts = {
                            method,
                            agent: false,
                            socket,
                            rejectUnauthorized: !(conf.proxyunauthorized || false),
                        };

                        let req = require(protocol).request(url, opts, res2 => {
                            let status = res2.statusCode,
                                headers = res2.headers,
                                data = 0;
                            if (method === 'HEAD') {
                                resolve({url: url.toString(), status, headers});
                            }
                            else {
                                res2.on('data', dt => {
                                    if (typeof dt === 'string') {
                                        data += dt.length;
                                    }
                                    else if (Buffer.isBuffer(dt)) {
                                        data += dt.byteLength;
                                    }
                                });
                                res2.on('end', () => {
                                    if (!headers['content-length']) {
                                        headers['content-length'] = data || 0;
                                    }
                                    resolve({url: url.toString(), status, headers});
                                });
                            }
                        });
                        req.on('error', err => {
                            log.e('error when HEADing ' + url, err);
                            reject(new ValidationError('Cannot access proxied URL'));
                        });
                        req.end();
                    }
                    else {
                        log.e('Cannot connect to proxy %j: %j / %j', opts, res.statusCode, res.statusMessage);
                        reject(new ValidationError('Cannot access proxy server'));
                    }
                })
                .on('error', err => {
                    reject(new ValidationError('Cannot CONNECT to proxy server'));
                    log.e('error when CONNECTing %j', opts, err);
                })
                .end();
        }
        else {
            require(protocol)
                .request(url, {method}, res => {
                    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                        mimeInfo(res.headers.location).then(resolve, reject);
                    }
                    else {
                        let status = res.statusCode,
                            headers = res.headers,
                            data = 0;
                        if (method === 'HEAD') {
                            resolve({url: url.toString(), status, headers});
                        }
                        else {
                            res.on('data', dt => {
                                if (typeof dt === 'string') {
                                    data += dt.length;
                                }
                                else if (Buffer.isBuffer(dt)) {
                                    data += dt.byteLength;
                                }
                            });
                            res.on('end', () => {
                                if (!headers['content-length']) {
                                    headers['content-length'] = data || 0;
                                }
                                resolve({url: url.toString(), status, headers});
                            });
                        }
                    }
                })
                .on('error', err => {
                    log.e('error when HEADing ' + url, err);
                    reject(new ValidationError('Cannot access URL'));
                })
                .end();
        }
    });
}

module.exports.mimeInfo = mimeInfo;