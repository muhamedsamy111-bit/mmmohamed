'use strict';

const express = require('express');
const { def } = require('./registry');
const { q, f } = require('../helpers/httpx');
const models = require('../db/models');

const router = express.Router();
const COMMUNITY_ROLES = new Set(['admin', 'employee', 'user']);

function canUseCommunity(req, res) {
  if (COMMUNITY_ROLES.has(req.user.role)) return true;
  res.flashRedirect('/mental/ppd', 'المجتمع متاح للمواطنين والموظفين فقط.', 'warning');
  return false;
}

function ownOrAdmin(req, author) {
  return req.user.role === 'admin' || req.user.username === author;
}

def(router, {
  name: 'community_home',
  path: '/community',
  handler: async (req, res) => {
    if (!canUseCommunity(req, res)) return;
    const category = String(q(req, 'category')).trim();
    const search = String(q(req, 'q')).trim().slice(0, 100);
    return res.view('community.html', {
      posts: models.listCommunityPosts({ category, search, username: req.user.username, includeHidden: req.user.role === 'admin' }),
      categories: models.COMMUNITY_CATEGORIES,
      selected_category: category,
      search,
      is_admin: req.user.role === 'admin',
      not_found: false
    });
  }
});

def(router, {
  name: 'community_new_post',
  method: ['get', 'post'],
  path: '/community/new',
  handler: async (req, res) => {
    if (!canUseCommunity(req, res)) return;
    let error = '';
    let values = { title: '', category: '', body: '' };
    if (req.method === 'POST') {
      values = { title: String(f(req, 'title')), category: String(f(req, 'category')), body: String(f(req, 'body')) };
      const result = models.createCommunityPost({
        username: req.user.username,
        authorName: req.user.name,
        ...values
      });
      if (result.ok) return res.flashRedirect(`/community/${result.id}`, 'تم نشر موضوعك في المجتمع.', 'success');
      error = result.msg;
    }
    return res.view('community_new.html', { categories: models.COMMUNITY_CATEGORIES, error, values });
  }
});

def(router, {
  name: 'community_thread',
  path: '/community/:id',
  handler: async (req, res) => {
    if (!canUseCommunity(req, res)) return;
    const post = models.getCommunityPost(req.params.id);
    if (!post) return res.view('community.html', {
      posts: models.listCommunityPosts({ username: req.user.username }),
      categories: models.COMMUNITY_CATEGORIES,
      selected_category: '', search: '', is_admin: req.user.role === 'admin',
      not_found: true
    }, 404);
    post.liked_by_me = models.listCommunityPosts({ username: req.user.username }).find((p) => p.id === post.id)?.liked_by_me || 0;
    return res.view('community_thread.html', {
      post,
      is_admin: req.user.role === 'admin',
      can_delete_post: ownOrAdmin(req, post.author_username)
    });
  }
});

def(router, {
  name: 'community_reply',
  method: 'post',
  path: '/community/:id/replies',
  handler: async (req, res) => {
    if (!canUseCommunity(req, res)) return;
    const result = models.addCommunityReply({
      postId: req.params.id,
      username: req.user.username,
      authorName: req.user.name,
      body: f(req, 'body')
    });
    return res.flashRedirect(`/community/${req.params.id}`, result.ok ? 'تمت إضافة ردك.' : result.msg, result.ok ? 'success' : 'danger');
  }
});

def(router, {
  name: 'community_like',
  method: 'post',
  path: '/community/:id/like',
  handler: async (req, res) => {
    if (!canUseCommunity(req, res)) return;
    const result = models.toggleCommunityLike(req.params.id, req.user.username);
    return res.flashRedirect(`/community/${req.params.id}`, result.ok ? '' : result.msg, result.ok ? 'info' : 'warning');
  }
});

def(router, {
  name: 'community_post_delete',
  method: 'post',
  path: '/community/:id/delete',
  handler: async (req, res) => {
    if (!canUseCommunity(req, res)) return;
    const result = models.deleteCommunityPost(req.params.id, req.user.username, req.user.role === 'admin');
    return res.flashRedirect('/community', result.ok ? 'تم حذف الموضوع.' : result.msg, result.ok ? 'success' : 'danger');
  }
});

def(router, {
  name: 'community_reply_delete',
  method: 'post',
  path: '/community/:id/replies/:replyId/delete',
  handler: async (req, res) => {
    if (!canUseCommunity(req, res)) return;
    const result = models.deleteCommunityReply(req.params.replyId, req.user.username, req.user.role === 'admin');
    return res.flashRedirect(`/community/${req.params.id}`, result.ok ? 'تم حذف الرد.' : result.msg, result.ok ? 'success' : 'danger');
  }
});

def(router, {
  name: 'community_moderate',
  method: 'post',
  path: '/admin/community/:id/moderate',
  handler: async (req, res) => {
    if (req.user.role !== 'admin') return res.flashRedirect('/community', 'الإشراف على المجتمع للمدير فقط.', 'danger');
    const result = models.moderateCommunityPost(req.params.id, String(f(req, 'status')));
    return res.flashRedirect('/community', result.ok ? 'تم تحديث حالة الموضوع.' : result.msg, result.ok ? 'success' : 'danger');
  }
});

module.exports = router;
