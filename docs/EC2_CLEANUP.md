# Cleaning Up: Stopping and Deleting the EC2 Instance

When you're done with the arena (testing complete, moving to a new instance, etc.), follow these steps to clean up and avoid AWS charges.

## Stopping vs. Terminating

- **Stop**: Pauses the instance. You keep the storage. Costs minimal ($0.10/GB-month for storage). Use this if you might come back.
- **Terminate**: Permanently deletes the instance and storage. Costs nothing. Use this when you're truly done.

## Option 1: Stop the Instance (Keep It for Later)

### In the AWS Console

1. **EC2 Dashboard** → **Instances**
2. Right-click on `tag-arena` → **Instance State** → **Stop**
3. Wait ~1 minute. Status changes to **Stopped**.
4. Your data is preserved on the EBS volume. You can restart it later.

### Cost While Stopped
- Instance compute: $0
- EBS storage (20 GB): ~$2/month
- Static IP (if you reserved one): ~$3/month

To restart: right-click → **Instance State** → **Start**.

---

## Option 2: Terminate the Instance (Complete Cleanup)

### In the AWS Console

1. **EC2 Dashboard** → **Instances**
2. Right-click on `tag-arena` → **Instance State** → **Terminate**
3. Confirm the deletion
4. Wait ~1 minute. Instance disappears from the list.

### What Gets Deleted
- The EC2 instance (compute) — cost becomes $0
- The EBS volume (storage) — cost becomes $0
- Everything on the server (your arena state, the code, logs)

**Caveat**: If you backed up `arena.json`, you can restore it to a new instance. Otherwise, the game record is gone.

---

## Before You Terminate: Backup

Save your arena's game record:

```bash
# From your local machine (not the server)
scp -i Create_select.pem ubuntu@ec2-18-191-200-8.us-east-2.compute.amazonaws.com:/var/lib/tag/arena.json ./arena-final-$(date +%Y%m%d).json
```

This downloads the game log to your local machine. You can restore it to a new arena later if needed.

---

## Clean Up Local Files

After you terminate the instance, you can delete local files to save space:

```bash
# Delete the SSH key (keep a backup if you might restart the instance)
rm ~/Downloads/Create_select.pem

# Delete any local arena backups (optional)
rm ~/arena-backup-*.json

# Delete the cloned repo if you're done with it
rm -rf ~/tag-arena
```

---

## Costs: Did I Pay for Anything?

**If you used free tier (new AWS account, t3.micro, < 1 month):**
- Compute: **$0**
- Storage (20 GB): **$0** (free tier covers 30 GB)
- Data transfer: **$0** (free tier covers 100 GB outbound)
- **Total: $0**

**After free tier expires (or larger instance):**
- t3.micro: ~$5/month
- Data transfer: ~$1/month per 100 GB
- Static IP (if reserved): ~$3/month when stopped, $0 when running
- Backup (EBS snapshots): ~$0.05 per GB-month

**Bottom line:** Stop the instance if pausing. Terminate if truly done. Either way, you save money.

---

## To Restart Later

1. **EC2 Dashboard** → **Instances** → **Stopped instances**
2. Right-click on `tag-arena` → **Instance State** → **Start**
3. Wait ~2 minutes for it to boot
4. Get the new public IP address (it changes after a stop/start)
5. Update your DNS A record to the new IP
6. SSH in and start the service: `sudo systemctl start tag`

---

## If You Lost Your SSH Key

If you deleted `Create_select.pem` and the instance is still running, you can connect via **EC2 Instance Connect** (AWS Console):

1. **EC2 Dashboard** → **Instances** → select `tag-arena`
2. **Connect** button (top right)
3. Choose **EC2 Instance Connect** tab
4. Click **Connect**
5. Browser-based terminal opens

From there you can manage the instance without needing the `.pem` file.

---

## Checklist Before Terminating

- [ ] Backed up `arena.json` if you want to preserve the game record
- [ ] Noted the final round number and agent count (for your own records)
- [ ] Terminated the Caddy reverse proxy if it's on a separate instance
- [ ] Deleted the DNS A record (optional, but keeps things clean)
- [ ] Confirmed you won't need the instance again soon

Once all checked, terminate with confidence.
